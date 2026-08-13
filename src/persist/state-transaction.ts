import type { ProtectionTarget } from '../domain/protection.js';
import type { ProtectionState } from '../state/schema.js';
import { StateRepository } from '../state/repository.js';
import type { ExecutionResult } from './executor.js';

/** Binds the application transaction lifecycle to revisioned state commits. */
export function createRepositoryStateTransaction(
  repository: StateRepository,
  initial: ProtectionState,
  requestedTarget: ProtectionTarget,
) {
  let revision = initial.revision;
  const commit = async (next: Parameters<StateRepository['commit']>[1]) => {
    const result = await repository.commit(revision, next);
    revision = result.value.revision;
  };
  return {
    begin: async (transactionId: string) => commit({
      committedTarget: initial.committedTarget, preferredRegion: initial.preferredRegion,
      health: initial.health, degradation: initial.degradation, activeTransactionId: transactionId,
    }),
    complete: async (result: Extract<ExecutionResult, { kind: 'committable' | 'degraded' }>) => commit({
      committedTarget: requestedTarget, preferredRegion: requestedTarget.region,
      health: result.kind === 'degraded' ? 'degraded' : 'healthy', degradation: [...result.degraded], activeTransactionId: null,
    }),
    fail: async (result: Extract<ExecutionResult, { kind: 'compensated' | 'recovery_required' }>) => commit({
      committedTarget: initial.committedTarget, preferredRegion: initial.preferredRegion,
      health: result.kind === 'recovery_required' ? 'recovery_required' : initial.health,
      degradation: result.kind === 'recovery_required' ? [] : initial.degradation, activeTransactionId: null,
    }),
  };
}
