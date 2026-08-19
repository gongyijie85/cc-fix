import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { InProcessTestMutationCoordinator } from '../../state/test-support/in-process-mutation-coordinator.js';
import { createMutationCoordinatorCapability, mutationRootGateKey, type MutationLockRequest } from '../../state/repository.js';
import { createFileMutationCoordinator, MutationRecoveryRequiredError } from '../../state/mutation-coordinator.js';
import { withPersistTransactionLock } from './internal/transaction-lock.js';

describe('persist transaction root lock', () => {
  it('holds one root gate across the complete action and releases it', async () => {
    const coordinator = new InProcessTestMutationCoordinator();
    const result = await withPersistTransactionLock('C:\\state', coordinator.capability, 'persist.protect', async () => 42);
    expect(result).toBe(42);
    expect(coordinator.requests).toHaveLength(1);
    expect(coordinator.requests[0]?.operation).toBe('persist.protect');
  });

  it('takes over a dead owner root lock only for the recover operation (issue #51 H1)', async () => {
    const requests: MutationLockRequest[] = [];
    const deadOwner = { pid: 1, startedAtMs: 1, heartbeatAtMs: 1, lockId: 'dead' };
    const coordinator = createMutationCoordinatorCapability({
      acquire: async (request) => {
        requests.push(request);
        if (request.recoveryComplete !== true) throw new MutationRecoveryRequiredError(deadOwner);
        return { release: async () => undefined };
      },
    });
    // protect/restore 保持 fail-closed：残留死锁把用户引导到 recover。
    await expect(withPersistTransactionLock('C:\\state', coordinator, 'persist.protect', async () => 1))
      .rejects.toBeInstanceOf(MutationRecoveryRequiredError);
    await expect(withPersistTransactionLock('C:\\state', coordinator, 'persist.restore', async () => 1))
      .rejects.toBeInstanceOf(MutationRecoveryRequiredError);
    // recover：先 recovery_required，再带 recoveryComplete 接管。
    const result = await withPersistTransactionLock('C:\\state', coordinator, 'persist.recover', async () => 42);
    expect(result).toBe(42);
    expect(requests.filter((request) => request.recoveryComplete === true)).toHaveLength(1);
    expect(requests[requests.length - 1]?.operation).toBe('persist.recover');
  });

  it('propagates action and release failures without losing either error', async () => {
    const releaseError = new Error('release failed');
    const coordinator = createMutationCoordinatorCapability({ acquire: async () => ({ release: async () => { throw releaseError; } }) });
    await expect(withPersistTransactionLock('C:\\state', coordinator, 'persist.restore', async () => 1)).rejects.toBe(releaseError);
    const actionError = new Error('action failed');
    const healthy = createMutationCoordinatorCapability({ acquire: async () => ({ release: async () => undefined }) });
    await expect(withPersistTransactionLock('C:\\state', healthy, 'persist.recover', async () => { throw actionError; })).rejects.toBe(actionError);
    await expect(withPersistTransactionLock('C:\\state', coordinator, 'persist.protect', async () => { throw actionError; })).rejects.toMatchObject({
      name: 'AggregateError', errors: [actionError, releaseError],
    });
  });
});

// 验收标准（issue #51）：kill -9 持锁进程后 `persist recover` 能完成恢复并清理锁文件。
// 以"必然不存在的 PID 残留锁文件"等价模拟 kill -9 现场（字节级相同），走真实
// 文件锁 + 真实 PowerShell 存活探测。
describe.skipIf(process.platform !== 'win32')('real file lock takeover (issue #51)', () => {
  it('recovers through a stale dead-owner root lock and cleans it up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-stale-root-'));
    const coordinator = createFileMutationCoordinator();
    const lockName = `${createHash('sha256').update(mutationRootGateKey(root)).digest('hex')}.lock`;
    const lockPath = join(root, 'locks', lockName);
    await mkdir(join(root, 'locks'), { recursive: true });
    await writeFile(lockPath, `${JSON.stringify({ pid: 2_147_483_647, startedAtMs: 1, heartbeatAtMs: 1, lockId: 'killed-owner' })}\n`, 'utf8');

    // 普通操作 fail-closed：残留死锁把用户引导到 recover。
    await expect(withPersistTransactionLock(root, coordinator, 'persist.protect', async () => 1))
      .rejects.toBeInstanceOf(MutationRecoveryRequiredError);

    // recover：接管死锁持有者 → 执行恢复动作 → 释放并删除锁文件。
    const result = await withPersistTransactionLock(root, coordinator, 'persist.recover', async () => 42);
    expect(result).toBe(42);
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // 锁已清理：下一次普通操作直接成功。
    const next = await withPersistTransactionLock(root, coordinator, 'persist.protect', async () => 7);
    expect(next).toBe(7);
  });
});