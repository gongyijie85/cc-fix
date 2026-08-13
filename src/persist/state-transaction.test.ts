import { describe, expect, it } from 'vitest';
import type { StateRepository } from '../state/repository.js';
import { createRepositoryStateTransaction } from './state-transaction.js';

describe('repository state transaction', () => {
  it('keeps the old target visible until completion and advances revisions', async () => {
    const writes: unknown[] = [];
    let revision = 3;
    const repository = { commit: async (expected: number, next: object) => {
      expect(expected).toBe(revision);
      revision += 1; writes.push(next);
      return { value: { ...next, schemaVersion: 1, revision, updatedAt: '2026-08-13T00:00:00.000Z' } };
    } } as unknown as StateRepository;
    const initial = { schemaVersion: 1 as const, revision: 3, committedTarget: { mode: 'standard' as const, region: 'us' as const }, preferredRegion: 'us' as const, health: 'healthy' as const, degradation: [], activeTransactionId: null, updatedAt: '2026-08-13T00:00:00.000Z' };
    const transaction = createRepositoryStateTransaction(repository, initial, { mode: 'deep', region: 'jp' });
    await transaction.begin('tx-1');
    expect(writes[0]).toMatchObject({ committedTarget: initial.committedTarget, activeTransactionId: 'tx-1' });
    await transaction.complete({ kind: 'committable', degraded: [] });
    expect(writes[1]).toMatchObject({ committedTarget: { mode: 'deep', region: 'jp' }, preferredRegion: 'jp', activeTransactionId: null });
  });
});
