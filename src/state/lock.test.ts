import { describe, expect, it } from 'vitest';
import { acquireStateMutationLock, type LockRecord, type LockStore } from './lock.js';

class MemoryLockStore implements LockStore {
  value: LockRecord | undefined;
  async read() { return this.value; }
  async create(record: LockRecord) { if (this.value !== undefined) return false; this.value = record; return true; }
  async replace(expected: LockRecord, next: LockRecord) {
    if (this.value?.lockId !== expected.lockId || this.value.heartbeatAtMs !== expected.heartbeatAtMs) return false;
    this.value = next; return true;
  }
  async remove(expected: LockRecord) { if (this.value?.lockId !== expected.lockId) return false; this.value = undefined; return true; }
}

describe('state mutation lock', () => {
  it('never displaces a live owner just because its heartbeat is old', async () => {
    const store = new MemoryLockStore();
    const first = await acquireStateMutationLock({ store, now: 1, inspector: { current: async () => ({ pid: 1, startedAtMs: 1 }), isSameProcess: async () => true } });
    expect(first.kind).toBe('acquired');
    const blocked = await acquireStateMutationLock({ store, now: 999_999, recoveryComplete: true, inspector: { current: async () => ({ pid: 2, startedAtMs: 2 }), isSameProcess: async () => true } });
    expect(blocked).toMatchObject({ kind: 'recovery_required', owner: { pid: 1 } });
  });

  it('requires recovery to be acknowledged before exact dead-owner takeover', async () => {
    const store = new MemoryLockStore();
    store.value = { pid: 7, startedAtMs: 10, heartbeatAtMs: 10, lockId: 'dead' };
    const inspector = { current: async () => ({ pid: 9, startedAtMs: 20 }), isSameProcess: async () => false };
    expect((await acquireStateMutationLock({ store, now: 21, inspector })).kind).toBe('recovery_required');
    const acquired = await acquireStateMutationLock({ store, now: 21, inspector, recoveryComplete: true });
    expect(acquired).toMatchObject({ kind: 'acquired', previousOwner: { lockId: 'dead' } });
    if (acquired.kind === 'acquired') { await acquired.lock.heartbeat(22); await acquired.lock.release(); }
    expect(store.value).toBeUndefined();
  });
});
