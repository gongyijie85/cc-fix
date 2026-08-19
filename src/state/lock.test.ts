import { describe, expect, it } from 'vitest';
import { acquireStateMutationLock, type LockRecord, type LockStore } from './lock.js';
import { createWindowsProcessInspector, nodeProcessInspector } from './process-owner.js';

class MemoryLockStore implements LockStore {
  value: LockRecord | undefined;
  async read() { return this.value; }
  async create(record: LockRecord) { if (this.value !== undefined) return false; this.value = record; return true; }
  // 契约（issue #51 H2）：replace/remove 按锁身份 lockId 匹配，heartbeatAtMs 过期不影响所有权判定。
  async replace(expected: LockRecord, next: LockRecord) {
    if (this.value?.lockId !== expected.lockId) return false;
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

  it('bounds acquisition retries so persistent contention cannot spin forever (issue #51 L1)', async () => {
    const store = new MemoryLockStore();
    // create 永远失败且 read 永远 undefined：每次重试都扑空，必须收敛为显式失败。
    store.create = async () => false;
    store.read = async () => undefined;
    const inspector = { current: async () => ({ pid: 1, startedAtMs: 1 }), isSameProcess: async () => false };
    await expect(acquireStateMutationLock({ store, now: 1, inspector })).rejects.toThrow(/did not converge/);
  });

  it('propagates inspection failure instead of reporting the owner as dead (issue #51 M1)', async () => {
    const store = new MemoryLockStore();
    store.value = { pid: 7, startedAtMs: 10, heartbeatAtMs: 10, lockId: 'unknown-liveness' };
    const inspector = {
      current: async () => ({ pid: 9, startedAtMs: 20 }),
      isSameProcess: async () => { throw new Error('query failed'); },
    };
    await expect(acquireStateMutationLock({ store, now: 21, inspector, recoveryComplete: true })).rejects.toThrow('query failed');
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
