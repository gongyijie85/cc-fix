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
  // SilentlyContinue + 'MISSING' 标记把"进程确认不存在"编码为正常输出（issue #51 M1）；
  // 其余失败（PowerShell 缺失/超时/权限）一律上抛 —— "查询失败"绝不等于"进程已死"。
  const command = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') } else { 'MISSING' }`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8' });
  const text = stdout.trim();
  if (text === 'MISSING') return undefined;
  const value = Date.parse(text);
  if (!Number.isFinite(value)) throw new Error(`Unexpected process start-time output for PID ${pid}`);
  return value;
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
      const result = await acquireStateMutationLock({
        store,
        inspector,
        now: now(),
        recoveryComplete: request.recoveryComplete === true,
      });
      if (result.kind === 'busy') throw new MutationBusyError(result.owner);
      if (result.kind === 'recovery_required') throw new MutationRecoveryRequiredError(result.owner);
      let heartbeatError: unknown;
      const timer = setInterval(() => {
        // 瞬时心跳失败可被后续成功覆盖（issue #51 L2），只有持续失败才在 release 时上抛。
        void result.lock.heartbeat(now()).then(
          () => { heartbeatError = undefined; },
          (error) => { heartbeatError = error; },
        );
      }, heartbeatMs);
      timer.unref();
      return { release: async () => { clearInterval(timer); await result.lock.release(); if (heartbeatError !== undefined) throw heartbeatError; } };
    },
  });
}
