import { describe, expect, it } from 'vitest';
import { acquireStateMutationLock, type LockRecord, type LockStore } from './lock.js';
import { createWindowsProcessInspector, nodeProcessInspector } from './process-owner.js';

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
    expect(blocked).toMatchObject({ kind: 'busy', owner: { pid: 1 } });
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

describe('Windows process identity', () => {
  it('compares PID and exact creation time rather than PID alone', async () => {
    const starts = new Map([[process.pid, 100], [7, 200]]);
    const inspector = createWindowsProcessInspector(async (pid) => starts.get(pid));
    expect(await inspector.current()).toEqual({ pid: process.pid, startedAtMs: 100 });
    expect(await inspector.isSameProcess({ pid: 7, startedAtMs: 200 })).toBe(true);
    expect(await inspector.isSameProcess({ pid: 7, startedAtMs: 199 })).toBe(false);
  });

  it('fails when native inspection cannot establish the current identity', async () => {
    const inspector = createWindowsProcessInspector(async () => undefined);
    await expect(inspector.current()).rejects.toThrow(/start time/i);
  });

  it('identifies only the exact current Node process identity', async () => {
    const current = await nodeProcessInspector.current();
    expect(await nodeProcessInspector.isSameProcess(current)).toBe(true);
    expect(await nodeProcessInspector.isSameProcess({ ...current, pid: current.pid + 1 })).toBe(false);
    expect(await nodeProcessInspector.isSameProcess({ ...current, startedAtMs: current.startedAtMs + 1 })).toBe(false);
  });
});
