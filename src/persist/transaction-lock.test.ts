import { describe, expect, it } from 'vitest';
import { InProcessTestMutationCoordinator } from '../state/test-support/in-process-mutation-coordinator.js';
import { createMutationCoordinatorCapability } from '../state/repository.js';
import { withPersistTransactionLock } from './transaction-lock.js';

describe('persist transaction root lock', () => {
  it('holds one root gate across the complete action and releases it', async () => {
    const coordinator = new InProcessTestMutationCoordinator();
    const result = await withPersistTransactionLock('C:\\state', coordinator.capability, 'persist.protect', async () => 42);
    expect(result).toBe(42);
    expect(coordinator.requests).toHaveLength(1);
    expect(coordinator.requests[0]?.operation).toBe('persist.protect');
  });

  it('propagates action and release failures without losing either error', async () => {
    const releaseError = new Error('release failed');
    const coordinator = createMutationCoordinatorCapability({ acquire: async () => ({ release: async () => { throw releaseError; } }) });
    await expect(withPersistTransactionLock('C:\\state', coordinator, 'persist.restore', async () => 1)).rejects.toBe(releaseError);
    const actionError = new Error('action failed');
    const healthy = createMutationCoordinatorCapability({ acquire: async () => ({ release: async () => undefined }) });
    await expect(withPersistTransactionLock('C:\\state', healthy, 'persist.recover', async () => { throw actionError; })).rejects.toBe(actionError);
    await expect(withPersistTransactionLock('C:\\state', coordinator, 'persist.protect', async () => { throw actionError; })).rejects.toMatchObject({
      name: 'AggregateError', errors: [actionError, releaseError],
    });
  });
});
