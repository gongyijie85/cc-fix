import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileMutationCoordinator, MutationBusyError, MutationRecoveryRequiredError, queryWindowsProcessStartedAtMs } from './mutation-coordinator.js';

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

  it('validates PID inputs and reports missing Windows processes without throwing', async () => {
    await expect(queryWindowsProcessStartedAtMs(0)).resolves.toBeUndefined();
    await expect(queryWindowsProcessStartedAtMs(-1)).resolves.toBeUndefined();
    await expect(queryWindowsProcessStartedAtMs(Number.NaN)).resolves.toBeUndefined();
    await expect(queryWindowsProcessStartedAtMs(2_147_483_647)).resolves.toBeUndefined();
    await expect(queryWindowsProcessStartedAtMs(process.pid)).resolves.toEqual(expect.any(Number));
  });
});
