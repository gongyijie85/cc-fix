import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileMutationCoordinator, MutationBusyError, MutationRecoveryRequiredError, queryWindowsProcessStartedAtMs } from './mutation-coordinator.js';
import { createWindowsProcessInspector } from './process-owner.js';

describe('file mutation coordinator', () => {
  it('enforces cross-instance exclusion for the same lock key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-coordinator-'));
    const inspector = { current: async () => ({ pid: 1, startedAtMs: 1 }), isSameProcess: async () => true };
    const first = createFileMutationCoordinator({ inspector, heartbeatMs: 60_000, now: () => 1 });
    const second = createFileMutationCoordinator({ inspector, heartbeatMs: 60_000, now: () => 2 });
    const request = { lockKey: 'same', stateRoot: root, filePath: join(root, 'state.json'), operation: 'state.commit' as const };
    const held = await first.acquire(request);
    await expect(second.acquire(request)).rejects.toBeInstanceOf(MutationBusyError);
    await held.release();
    const next = await second.acquire(request);
    await next.release();
  });

  it('requires recovery before taking over a lock whose exact owner is dead', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-coordinator-dead-'));
    const live = { current: async () => ({ pid: 1, startedAtMs: 1 }), isSameProcess: async () => true };
    const dead = { current: async () => ({ pid: 2, startedAtMs: 2 }), isSameProcess: async () => false };
    const request = { lockKey: 'dead-owner', stateRoot: root, filePath: join(root, 'state.json'), operation: 'state.commit' as const };
    const held = await createFileMutationCoordinator({ inspector: live, heartbeatMs: 60_000, now: () => 1 }).acquire(request);
    await expect(createFileMutationCoordinator({ inspector: dead, heartbeatMs: 60_000, now: () => 2 }).acquire(request)).rejects.toBeInstanceOf(MutationRecoveryRequiredError);
    await held.release();
  });

  it('takes over a dead owner lock when the request opts into recovery (issue #51 H1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-coordinator-takeover-'));
    // pid=1 的"持有者"：只有 pid=1 自己认它活着；第二个协调器视其为死亡。
    const firstInspector = { current: async () => ({ pid: 1, startedAtMs: 1 }), isSameProcess: async (owner: { pid: number }) => owner.pid === 1 };
    const secondInspector = { current: async () => ({ pid: 2, startedAtMs: 2 }), isSameProcess: async (owner: { pid: number }) => owner.pid === 2 };
    const request = {
      lockKey: 'dead-owner-takeover',
      stateRoot: root,
      filePath: join(root, 'state.json'),
      operation: 'state.commit' as const,
    };
    // 模拟崩溃：获取后不释放，锁文件残留 pid=1。
    await createFileMutationCoordinator({ inspector: firstInspector, heartbeatMs: 60_000, now: () => 1 }).acquire(request);
    const second = createFileMutationCoordinator({ inspector: secondInspector, heartbeatMs: 60_000, now: () => 2 });
    // 普通请求：fail-closed，引导用户走恢复。
    await expect(second.acquire(request)).rejects.toBeInstanceOf(MutationRecoveryRequiredError);
    // recoveryComplete 请求：接管死锁持有者，随后正常释放与再获取。
    const taken = await second.acquire({ ...request, recoveryComplete: true });
    await taken.release();
    const next = await second.acquire(request);
    await next.release();
  });

  it('releases cleanly while heartbeats continuously race the release (issue #51 H2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-coordinator-race-'));
    const inspector = { current: async () => ({ pid: 3, startedAtMs: 3 }), isSameProcess: async (owner: { pid: number }) => owner.pid === 3 };
    // 1ms 心跳间隔：持锁期间 claim 段几乎被连续占用，旧实现下 release 大概率
    // 误判 "Lock ownership was lost" 且锁文件永不删除。
    const coordinator = createFileMutationCoordinator({ inspector, heartbeatMs: 1 });
    const request = { lockKey: 'heartbeat-race', stateRoot: root, filePath: join(root, 'state.json'), operation: 'state.commit' as const };
    const held = await coordinator.acquire(request);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await held.release();
    // 锁文件已被删除：下一次 acquire 直接成功。
    const next = await coordinator.acquire(request);
    await next.release();
  });

  it('propagates inspection failure instead of treating the owner as dead (issue #51 M1)', async () => {
    const inspector = createWindowsProcessInspector(async () => { throw new Error('query failed'); });
    await expect(inspector.isSameProcess({ pid: 7, startedAtMs: 1 })).rejects.toThrow('query failed');
  });

  it('validates PID inputs and reports missing Windows processes without throwing', async () => {
    await expect(queryWindowsProcessStartedAtMs(0)).resolves.toBeUndefined();
    await expect(queryWindowsProcessStartedAtMs(-1)).resolves.toBeUndefined();
    await expect(queryWindowsProcessStartedAtMs(Number.NaN)).resolves.toBeUndefined();
    await expect(queryWindowsProcessStartedAtMs(2_147_483_647)).resolves.toBeUndefined();
    await expect(queryWindowsProcessStartedAtMs(process.pid)).resolves.toEqual(expect.any(Number));
  });
});
