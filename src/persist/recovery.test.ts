import { describe, expect, it } from 'vitest';
import { decideRecovery } from './recovery.js';

describe('recovery decision', () => {
  it('blocks new work behind deterministic protect or restore recovery', () => {
    expect(decideRecovery({ transactionId: 'p', kind: 'protect', steps: [{ id: 'environment', phase: 'applying' }] })).toEqual({ kind: 'protect_compensation', transactionId: 'p' });
    expect(decideRecovery({ transactionId: 'r', kind: 'restore', steps: [{ id: 'environment', phase: 'recovery_required' }] })).toEqual({ kind: 'restore_convergence', transactionId: 'r' });
    expect(decideRecovery(undefined)).toEqual({ kind: 'none' });
  });
});
