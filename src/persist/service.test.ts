import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storedMissing, storedValue } from '../state/schema.js';
import { TransactionJournalRepository } from '../state/journal.js';
import { derivePersistStatus, runProtectTransaction } from './service.js';
const state = { schemaVersion: 1 as const, revision: 1, committedTarget: { mode: 'deep' as const, region: 'jp' as const }, preferredRegion: 'jp' as const, health: 'healthy' as const, degradation: [], activeTransactionId: null, updatedAt: '2026-01-01T00:00:00.000Z' };
describe('persist status', () => {
  it('uses committed target and journal health, never backup existence', () => {
    expect(derivePersistStatus(state, undefined)).toMatchObject({ mode: 'deep', health: 'healthy' });
    expect(derivePersistStatus(state, { transactionId: 'x', kind: 'protect', steps: [{ id: 'environment', phase: 'applying' }] })).toMatchObject({ mode: 'deep', health: 'recovery_required', transaction: { kind: 'protect_compensation' } });
  });
  it('reports daily from null target even when other durable data exists', () => {
    expect(derivePersistStatus({ ...state, committedTarget: null, health: 'degraded' }, undefined)).toMatchObject({ mode: 'daily', health: 'degraded' });
  });
  it('reports an orphaned active state transaction even when the journal is complete', () => {
    expect(derivePersistStatus(
      { ...state, activeTransactionId: 'tx-orphan' },
      { transactionId: 'tx-orphan', kind: 'restore', steps: [{ id: 'backup_cleanup', phase: 'verified' }] },
    )).toMatchObject({ health: 'recovery_required', transaction: { kind: 'state_reconciliation', transactionId: 'tx-orphan' } });
  });
});

describe('protect transaction service', () => {
  it('persists the complete write-ahead plan and commits only after verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-service-'));
    const journalRepository = new TransactionJournalRepository(root, join(root, 'transaction-journal.json'));
    const values = new Map<string, unknown>();
    const order: string[] = [];
    const authority = (id: string) => ({ read: async () => storedValue(values.get(id) ?? `old-${id}`), write: async (next: ReturnType<typeof storedValue>) => { order.push(`write:${id}`); values.set(id, next.value); } });
    const ids = ['environment','system_timezone','browser_policies','locale_name','user_languages','user_culture'] as const;
    const authorities = Object.fromEntries(ids.map((id) => [id, authority(id)])) as never;
    const desired = Object.fromEntries(ids.map((id) => [id, storedValue(`new-${id}`)])) as never;
    const result = await runProtectTransaction({ committedTarget: null, requestedTarget: { mode: 'standard', region: 'us' }, observed: {}, desired, authorities, journalRepository, createDailySnapshot: async (snapshot) => { expect(Object.keys(snapshot)).toHaveLength(6); order.push('backup'); }, stateTransaction: { begin: async () => { order.push('begin'); }, complete: async () => { order.push('commit'); }, fail: async () => { order.push('fail'); } } });
    expect(result.kind).toBe('committable');
    expect(order.at(-1)).toBe('commit');
    expect(order[0]).toBe('backup');
    expect((await journalRepository.read())?.steps.every((step) => step.original !== undefined && step.desired !== undefined)).toBe(true);
  });

  it('creates the immutable backup and commits even when an initial target is naturally aligned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-service-aligned-'));
    const journalRepository = new TransactionJournalRepository(root, join(root, 'transaction-journal.json'));
    const ids = ['environment','system_timezone','browser_policies','locale_name','user_languages','user_culture'] as const;
    const authorities = Object.fromEntries(ids.map((id) => [id, { read: async () => storedValue(`value-${id}`), write: async () => undefined }])) as never;
    const desired = Object.fromEntries(ids.map((id) => [id, storedValue(`value-${id}`)])) as never;
    const order: string[] = [];
    const result = await runProtectTransaction({
      committedTarget: null,
      requestedTarget: { mode: 'standard', region: 'us' },
      observed: { environment: true, system_timezone: true, browser_policies: true },
      desired,
      authorities,
      journalRepository,
      createDailySnapshot: async () => { order.push('backup'); },
      stateTransaction: {
        begin: async () => { order.push('begin'); },
        complete: async () => { order.push('commit'); },
        fail: async () => { order.push('fail'); },
      },
    });
    expect(result.kind).toBe('committable');
    expect(order).toEqual(['backup', 'begin', 'commit']);
    expect((await journalRepository.read())?.steps).toEqual([]);
  });

  it('uses immutable daily values for deep-only restoration during a downshift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-service-downshift-'));
    const journalRepository = new TransactionJournalRepository(root, join(root, 'transaction-journal.json'));
    const ids = ['environment','system_timezone','browser_policies','locale_name','user_languages','user_culture'] as const;
    const writes = new Map<string, unknown>();
    const current = new Map(ids.map((id) => [id, storedValue(`protected-${id}`)]));
    const authorities = Object.fromEntries(ids.map((id) => [id, {
      read: async () => current.get(id)!,
      write: async (value: unknown) => { writes.set(id, value); current.set(id, value as never); },
    }])) as never;
    const desired = Object.fromEntries(ids.map((id) => [id, storedValue(`standard-${id}`)])) as never;
    const daily = Object.fromEntries(ids.map((id) => [id, storedMissing()])) as never;
    const result = await runProtectTransaction({
      committedTarget: { mode: 'deep', region: 'jp' },
      requestedTarget: { mode: 'standard', region: 'jp' },
      observed: { environment: true, system_timezone: true, browser_policies: true },
      desired,
      dailyValues: daily,
      authorities,
      journalRepository,
      stateTransaction: { begin: async () => undefined, complete: async () => undefined, fail: async () => undefined },
    });
    expect(result.kind).toBe('committable');
    expect(writes.get('locale_name')).toEqual(storedMissing());
  });
});
