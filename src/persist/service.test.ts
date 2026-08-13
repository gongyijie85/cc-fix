import { describe, expect, it } from 'vitest';
import { derivePersistStatus } from './service.js';
const state = { schemaVersion: 1 as const, revision: 1, committedTarget: { mode: 'deep' as const, region: 'jp' as const }, preferredRegion: 'jp' as const, health: 'healthy' as const, degradation: [], activeTransactionId: null, updatedAt: '2026-01-01T00:00:00.000Z' };
describe('persist status', () => {
  it('uses committed target and journal health, never backup existence', () => {
    expect(derivePersistStatus(state, undefined)).toMatchObject({ mode: 'deep', health: 'healthy' });
    expect(derivePersistStatus(state, { transactionId: 'x', kind: 'protect', steps: [{ id: 'environment', phase: 'applying' }] })).toMatchObject({ mode: 'deep', health: 'recovery_required', transaction: { kind: 'protect_compensation' } });
  });
});
