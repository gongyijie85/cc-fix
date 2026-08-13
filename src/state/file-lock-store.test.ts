import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileLockStore } from './file-lock-store.js';

const inspector = { current: async () => ({ pid: 10, startedAtMs: 100 }), isSameProcess: async (owner: { pid: number; startedAtMs: number }) => owner.pid === 10 && owner.startedAtMs === 100 };
describe('cross-process file lock store', () => {
  it('uses create-new exclusion and exact-owner replace/remove', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-lock-store-'));
    const path = join(root, 'persist.lock');
    const first = new FileLockStore(path, inspector);
    const second = new FileLockStore(path, inspector);
    const owner = { pid: 10, startedAtMs: 100, heartbeatAtMs: 1, lockId: 'owner' };
    expect(await first.create(owner)).toBe(true);
    expect(await second.create({ ...owner, lockId: 'other' })).toBe(false);
    const heartbeat = { ...owner, heartbeatAtMs: 2 };
    expect(await first.replace(owner, heartbeat)).toBe(true);
    expect(await second.remove(owner)).toBe(false);
    expect(await first.remove(heartbeat)).toBe(true);
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
