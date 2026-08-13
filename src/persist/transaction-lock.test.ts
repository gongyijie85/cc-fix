import { describe, expect, it } from 'vitest';
import { InProcessTestMutationCoordinator } from '../state/test-support/in-process-mutation-coordinator.js';
import { withPersistTransactionLock } from './transaction-lock.js';

describe('persist transaction root lock', () => {
  it('holds one root gate across the complete action and releases it', async () => {
    const coordinator = new InProcessTestMutationCoordinator();
    const result = await withPersistTransactionLock('C:\\state', coordinator.capability, 'persist.protect', async () => 42);
    expect(result).toBe(42);
    expect(coordinator.requests).toHaveLength(1);
    expect(coordinator.requests[0]?.operation).toBe('persist.protect');
  });
});
