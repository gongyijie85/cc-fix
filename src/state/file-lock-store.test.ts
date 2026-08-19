import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileLockStore } from './file-lock-store.js';

const inspector = { current: async () => ({ pid: 10, startedAtMs: 100 }), isSameProcess: async (owner: { pid: number; startedAtMs: number }) => owner.pid === 10 && owner.startedAtMs === 100 };
describe('cross-process file lock store', () => {
  it('uses create-new exclusion and lock-identity replace/remove', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-lock-store-'));
    const path = join(root, 'persist.lock');
    const first = new FileLockStore(path, inspector);
    const second = new FileLockStore(path, inspector);
    const owner = { pid: 10, startedAtMs: 100, heartbeatAtMs: 1, lockId: 'owner' };
    expect(await first.create(owner)).toBe(true);
    expect(await second.create({ ...owner, lockId: 'other' })).toBe(false);
    const heartbeat = { ...owner, heartbeatAtMs: 2 };
    expect(await first.replace(owner, heartbeat)).toBe(true);
    // 所有权保护按锁身份（lockId）判定：不同身份不能删除/替换；
    // 同一身份即使 heartbeatAtMs 过期也可操作（issue #51 H2 契约）。
    expect(await second.remove({ ...owner, lockId: 'other' })).toBe(false);
    expect(await second.replace({ ...owner, lockId: 'other' }, heartbeat)).toBe(false);
    expect(await first.remove(owner)).toBe(true);
  });

  it('matches replace/remove on lock identity, tolerating a stale heartbeat timestamp (issue #51 H2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-lock-store-stale-'));
    const path = join(root, 'persist.lock');
    const store = new FileLockStore(path, inspector);
    const owner = { pid: 10, startedAtMs: 100, heartbeatAtMs: 1, lockId: 'owner' };
    await store.create(owner);
    // 心跳推进后，携带过期 heartbeatAtMs 的 expected（并发心跳/迟到的 release 场景）
    // 仍必须能完成 replace 与 remove —— 旧实现按整条记录比对会误判丢失所有权。
    expect(await store.replace({ ...owner, heartbeatAtMs: 999 }, { ...owner, heartbeatAtMs: 2 })).toBe(true);
    expect(await store.remove({ ...owner, heartbeatAtMs: 999 })).toBe(true);
    expect(await store.read()).toBeUndefined();
  });

  it('serializes concurrent claim-guarded operations from one process so release cannot lose the lock (issue #51 H2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-lock-store-race-'));
    const path = join(root, 'persist.lock');
    const storeA = new FileLockStore(path, inspector);
    const storeB = new FileLockStore(path, inspector);
    const owner = { pid: 10, startedAtMs: 100, heartbeatAtMs: 1, lockId: 'owner' };
    await storeA.create(owner);
    // 并发：A 的 heartbeat(replace) 与 B 的 remove 同时进入 claim 段。
    // 串行化 + lockId 匹配后，两个操作都成功，锁文件被删除。
    const [replaced, removed] = await Promise.all([
      storeA.replace(owner, { ...owner, heartbeatAtMs: 2 }),
      storeB.remove(owner),
    ]);
    expect(replaced).toBe(true);
    expect(removed).toBe(true);
    expect(await storeA.read()).toBeUndefined();
  });

  it('distinguishes missing, corrupt and non-file lock paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-lock-store-read-'));
    const missingPath = join(root, 'missing.lock');
    expect(await new FileLockStore(missingPath, inspector).read()).toBeUndefined();
    await writeFile(missingPath, '{');
    expect(await new FileLockStore(missingPath, inspector).read()).toBeUndefined();
    await writeFile(missingPath, '{}');
    expect(await new FileLockStore(missingPath, inspector).read()).toBeUndefined();
    const directoryPath = join(root, 'directory.lock');
    await mkdir(directoryPath);
    await expect(new FileLockStore(directoryPath, inspector).read()).rejects.toBeDefined();
  });
});
