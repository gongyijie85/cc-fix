import { describe, expect, it } from 'vitest';
import { installerPreflightExitCode } from './preflight.js';

describe('installer persist preflight', () => {
  it.each(['healthy', 'degraded'] as const)('allows idle %s committed state', (health) => {
    expect(installerPreflightExitCode({ mode: 'daily', target: null, preferredRegion: 'us', health, transaction: { kind: 'none' } })).toBe(0);
  });

  it('blocks recovery-required state', () => {
    expect(installerPreflightExitCode({ mode: 'daily', target: null, preferredRegion: 'us', health: 'recovery_required', transaction: { kind: 'none' } })).toBe(43);
  });

  it('blocks an active recovery decision regardless of the stored health', () => {
    expect(installerPreflightExitCode({
      mode: 'standard', target: { mode: 'standard', region: 'us' }, preferredRegion: 'us', health: 'recovery_required',
      transaction: { kind: 'state_reconciliation', transactionId: 'tx-1' },
    })).toBe(43);
  });
});
