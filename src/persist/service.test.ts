import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storedValue } from '../state/schema.js';
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
    const result = await runProtectTransaction({ committedTarget: null, requestedTarget: { mode: 'standard', region: 'us' }, observed: {}, desired, authorities, journalRepository, commit: async () => { order.push('commit'); } });
    expect(result.kind).toBe('committable');
    expect(order.at(-1)).toBe('commit');
    expect((await journalRepository.read())?.steps.every((step) => step.original !== undefined && step.desired !== undefined)).toBe(true);
  });
});
