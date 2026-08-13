import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { FileLockStore } from './file-lock-store.js';
import { acquireStateMutationLock } from './lock.js';
import { createWindowsProcessInspector, type ProcessInspector } from './process-owner.js';
import { createMutationCoordinatorCapability, type MutationCoordinatorCapability } from './repository.js';

const execFileAsync = promisify(execFile);
export class MutationRecoveryRequiredError extends Error {
  constructor(readonly owner: { pid: number; startedAtMs: number; heartbeatAtMs: number; lockId: string }) { super('A previous mutation owner must be recovered before new writes'); }
}
export class MutationBusyError extends Error {
  constructor(readonly owner: { pid: number; startedAtMs: number; heartbeatAtMs: number; lockId: string }) { super('Another live process owns the mutation lock'); }
}

export async function queryWindowsProcessStartedAtMs(pid: number): Promise<number | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8' });
    const value = Date.parse(stdout.trim());
    return Number.isFinite(value) ? value : undefined;
  } catch { return undefined; }
}

export function createFileMutationCoordinator(options?: {
  inspector?: ProcessInspector;
  heartbeatMs?: number;
  now?: () => number;
}): MutationCoordinatorCapability {
  const inspector = options?.inspector ?? createWindowsProcessInspector(queryWindowsProcessStartedAtMs);
  const heartbeatMs = options?.heartbeatMs ?? 5_000;
  const now = options?.now ?? Date.now;
  return createMutationCoordinatorCapability({
    acquire: async (request) => {
      const name = createHash('sha256').update(request.lockKey).digest('hex');
      const store = new FileLockStore(join(request.stateRoot, 'locks', `${name}.lock`), inspector);
      const result = await acquireStateMutationLock({ store, inspector, now: now() });
      if (result.kind === 'busy') throw new MutationBusyError(result.owner);
      if (result.kind === 'recovery_required') throw new MutationRecoveryRequiredError(result.owner);
      let heartbeatError: unknown;
      const timer = setInterval(() => { void result.lock.heartbeat(now()).catch((error) => { heartbeatError = error; }); }, heartbeatMs);
      timer.unref();
      return { release: async () => { clearInterval(timer); await result.lock.release(); if (heartbeatError !== undefined) throw heartbeatError; } };
    },
  });
}
