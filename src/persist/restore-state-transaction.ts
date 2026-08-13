import type { ProtectionState } from '../state/schema.js';
import { StateRepository } from '../state/repository.js';

/** Revisioned state phases for an off transaction and its cleanup boundary. */
export function createRepositoryRestoreStateTransaction(repository: StateRepository, initial: ProtectionState) {
  let revision = initial.revision;
  let dailyPublished = false;
  const commit = async (next: Parameters<StateRepository['commit']>[1]) => {
    const result = await repository.commit(revision, next);
    revision = result.value.revision;
  };
  return {
    begin: async (transactionId: string) => commit({
      committedTarget: initial.committedTarget,
      preferredRegion: initial.preferredRegion,
      health: initial.health,
      degradation: initial.degradation,
      activeTransactionId: transactionId,
    }),
    restored: async (transactionId: string) => {
      dailyPublished = true;
      await commit({
        committedTarget: null,
        preferredRegion: initial.preferredRegion,
        health: 'healthy',
        degradation: [],
        activeTransactionId: transactionId,
      });
    },
    complete: async () => commit({
      committedTarget: null,
      preferredRegion: initial.preferredRegion,
      health: 'healthy',
      degradation: [],
      activeTransactionId: null,
    }),
    failBeforeRestore: async () => commit({
      committedTarget: initial.committedTarget,
      preferredRegion: initial.preferredRegion,
      health: 'recovery_required',
      degradation: [],
      activeTransactionId: null,
    }),
    failCleanup: async (transactionId: string) => commit({
      committedTarget: dailyPublished ? null : initial.committedTarget,
      preferredRegion: initial.preferredRegion,
      health: 'recovery_required',
      degradation: [],
      activeTransactionId: transactionId,
    }),
  };
}
