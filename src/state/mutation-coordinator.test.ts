import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileMutationCoordinator, MutationBusyError } from './mutation-coordinator.js';

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
});
