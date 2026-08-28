import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProcessInspector } from './process-owner.js';
import type { LockRecord, LockStore } from './lock.js';

function serialized(record: LockRecord): string { return `${JSON.stringify(record)}\n`; }
function parse(text: string): LockRecord | undefined {
  try {
    const value = JSON.parse(text) as Partial<LockRecord>;
    return Number.isInteger(value.pid) && typeof value.startedAtMs === 'number' && typeof value.heartbeatAtMs === 'number' && typeof value.lockId === 'string'
      ? Object.freeze({ pid: value.pid!, startedAtMs: value.startedAtMs, heartbeatAtMs: value.heartbeatAtMs, lockId: value.lockId }) : undefined;
  } catch { return undefined; }
}
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function exists(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'EEXIST'; }

/**
 * 进程内按锁路径串行化 claim 保护段（issue #51 H2）。协调器每次 acquire 都
 * 新建 store 实例，因此队列必须挂在模块层：同进程的 heartbeat（replace）与
 * release（remove）会争用同一个 claim 文件，未串行化时 release 会误判
 * "Lock ownership was lost"，锁文件永不删除，最终落入永久锁死。跨进程互斥
 * 仍由 claim 文件本身承担。
 */
const claimTurns = new Map<string, Promise<unknown>>();

async function withClaimTurn<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  const predecessor = claimTurns.get(lockPath) ?? Promise.resolve();
  let releaseTurn: () => void = () => undefined;
  const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const tail = predecessor.catch(() => undefined).then(() => turn);
  claimTurns.set(lockPath, tail);
  await predecessor.catch(() => undefined);
  try {
    return await action();
  } finally {
    releaseTurn();
    if (claimTurns.get(lockPath) === tail) claimTurns.delete(lockPath);
  }
}

export class FileLockStore implements LockStore {
  private readonly claimPath: string;
  constructor(private readonly path: string, private readonly inspector: ProcessInspector) { this.claimPath = `${path}.claim`; }
  async read(): Promise<LockRecord | undefined> { try { return parse(await readFile(this.path, 'utf8')); } catch (error) { if (missing(error)) return undefined; throw error; } }
  async create(record: LockRecord): Promise<boolean> {
    await mkdir(dirname(this.path), { recursive: true });
    try { const handle = await open(this.path, 'wx', 0o600); try { await handle.writeFile(serialized(record), 'utf8'); await handle.sync(); } finally { await handle.close(); } return true; }
    catch (error) { if (exists(error)) return false; throw error; }
  }
  private async claim(): Promise<LockRecord | undefined> {
    const own = await this.inspector.current();
    const record: LockRecord = { ...own, heartbeatAtMs: Date.now(), lockId: randomUUID() };
    if (await this.createAt(this.claimPath, record)) return record;
    let holder: LockRecord | undefined;
    try { holder = parse(await readFile(this.claimPath, 'utf8')); } catch (error) { if (!missing(error)) throw error; }
    if (holder !== undefined && await this.inspector.isSameProcess(holder)) return undefined;
    try { await unlink(this.claimPath); } catch (error) { if (!missing(error)) return undefined; }
    return (await this.createAt(this.claimPath, record)) ? record : undefined;
  }
  private async createAt(path: string, record: LockRecord): Promise<boolean> {
    try { const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(serialized(record), 'utf8'); await handle.sync(); } finally { await handle.close(); } return true; }
    catch (error) { if (exists(error)) return false; throw error; }
  }
  private async releaseClaim(claim: LockRecord): Promise<void> {
    try { if (serialized(parse(await readFile(this.claimPath, 'utf8'))!) === serialized(claim)) await unlink(this.claimPath); } catch {}
  }
  async replace(expected: LockRecord, next: LockRecord): Promise<boolean> {
    return withClaimTurn(this.path, async () => {
      const claim = await this.claim(); if (claim === undefined) return false;
      const temp = `${this.path}.${claim.lockId}.tmp`;
      try {
        // 按 lockId 匹配锁身份：expected 的 heartbeatAtMs 可能因并发心跳而过期（issue #51 H2）。
        if ((await this.read())?.lockId !== expected.lockId) return false;
        const handle = await open(temp, 'wx', 0o600); try { await handle.writeFile(serialized(next), 'utf8'); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, this.path); return true;
      } finally { try { await unlink(temp); } catch {} await this.releaseClaim(claim); }
    });
  }
  async remove(expected: LockRecord): Promise<boolean> {
    return withClaimTurn(this.path, async () => {
      const claim = await this.claim(); if (claim === undefined) return false;
      try { if ((await this.read())?.lockId !== expected.lockId) return false; await unlink(this.path); return true; }
      finally { await this.releaseClaim(claim); }
    });
  }
}
