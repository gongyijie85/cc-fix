import { randomUUID } from 'node:crypto';
import type { ProcessInspector, ProcessOwner } from './process-owner.js';

export type LockRecord = Readonly<ProcessOwner & { lockId: string }>;
export type LockAcquireResult =
  | { kind: 'acquired'; lock: StateMutationLock; previousOwner?: LockRecord }
  | { kind: 'busy'; owner: LockRecord }
  | { kind: 'recovery_required'; owner: LockRecord };

export interface LockStore {
  read(): Promise<LockRecord | undefined>;
  /** Must create only when absent, atomically. */
  create(record: LockRecord): Promise<boolean>;
  /** Must replace only the exact existing record, atomically. */
  replace(expected: LockRecord, next: LockRecord): Promise<boolean>;
  /** Must remove only the exact existing record, atomically. */
  remove(expected: LockRecord): Promise<boolean>;
}

export class StateMutationLock {
  #released = false;
  #record: LockRecord;
  constructor(private readonly store: LockStore, record: LockRecord) { this.#record = record; }
  get record(): LockRecord { return this.#record; }
  async heartbeat(now: number): Promise<void> {
    if (this.#released) throw new Error('Cannot heartbeat a released lock');
    const next: LockRecord = Object.freeze({ ...this.#record, heartbeatAtMs: now });
    if (!(await this.store.replace(this.#record, next))) throw new Error('Lock ownership was lost');
    this.#record = next;
  }
  async release(): Promise<void> {
    if (this.#released) return;
    if (!(await this.store.remove(this.#record))) throw new Error('Lock ownership was lost');
    this.#released = true;
  }
}

/**
 * The age of a file is deliberately never used to steal a live lock.  A dead
 * owner produces recovery_required first; callers must inspect its journal
 * before retrying acquire with `recoveryComplete`.
 */
export async function acquireStateMutationLock(options: {
  store: LockStore;
  inspector: ProcessInspector;
  now: number;
  recoveryComplete?: boolean;
}): Promise<LockAcquireResult> {
  const own = await options.inspector.current();
  const proposed: LockRecord = Object.freeze({ ...own, heartbeatAtMs: options.now, lockId: randomUUID() });
  if (await options.store.create(proposed)) return { kind: 'acquired', lock: new StateMutationLock(options.store, proposed) };
  const existing = await options.store.read();
  if (existing === undefined) return acquireStateMutationLock(options);
  if (await options.inspector.isSameProcess(existing)) return { kind: 'busy', owner: existing };
  if (!options.recoveryComplete) return { kind: 'recovery_required', owner: existing };
  if (!(await options.store.replace(existing, proposed))) return acquireStateMutationLock(options);
  return { kind: 'acquired', lock: new StateMutationLock(options.store, proposed), previousOwner: existing };
}
