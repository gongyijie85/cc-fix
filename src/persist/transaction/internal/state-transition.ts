import type { ProtectionTarget } from '../../../domain/protection.js';
import type { ProtectionState } from '../../../state/schema.js';
import type { TransactionJournalContext } from '../../../state/journal.js';
import { StateRepository } from '../../../state/repository.js';
import type { ExecutionResult } from './executor.js';

/**
 * 唯一的状态提交编舞（ADR-0012 T-a）：一份 revision 追踪，三个视图（protect / restore / recover）
 * 覆盖三路径的全部提交时刻。调用方不再重建五字段状态，也不再各自持有 revision。
 */
export function createRepositoryStateTransition(repository: StateRepository, initial: ProtectionState, requestedTarget?: ProtectionTarget) {
  let revision = initial.revision;
  let dailyPublished = false;

  const commit = async (next: Parameters<StateRepository['commit']>[1]) => {
    const result = await repository.commit(revision, next);
    revision = result.value.revision;
  };

  const base = () => ({
    committedTarget: initial.committedTarget,
    preferredRegion: initial.preferredRegion,
    health: initial.health,
    degradation: initial.degradation,
    activeTransactionId: null as string | null,
  });

  const begin = (transactionId: string) => commit({ ...base(), activeTransactionId: transactionId });

  return Object.freeze({
    /** protect 事务（等价旧 state-transaction.ts）。 */
    protect: Object.freeze({
      begin,
      complete: (result: Extract<ExecutionResult, { kind: 'committable' | 'degraded' }>) => {
        if (requestedTarget === undefined) throw new Error('Protect transition requires a requested target');
        return commit({
          committedTarget: requestedTarget,
          preferredRegion: requestedTarget.region,
          health: result.kind === 'degraded' ? 'degraded' : 'healthy',
          degradation: [...result.degraded],
          activeTransactionId: null,
        });
      },
      fail: (result: Extract<ExecutionResult, { kind: 'compensated' | 'recovery_required' }>) =>
        commit({
          ...base(),
          health: result.kind === 'recovery_required' ? 'recovery_required' : initial.health,
          degradation: result.kind === 'recovery_required' ? [] : initial.degradation,
        }),
    }),
    /** restore 事务（等价旧 restore-state-transaction.ts）。 */
    restore: Object.freeze({
      begin,
      restored: (transactionId: string) => {
        dailyPublished = true;
        return commit({
          committedTarget: null,
          preferredRegion: initial.preferredRegion,
          health: 'healthy',
          degradation: [],
          activeTransactionId: transactionId,
        });
      },
      complete: () => commit({
        committedTarget: null,
        preferredRegion: initial.preferredRegion,
        health: 'healthy',
        degradation: [],
        activeTransactionId: null,
      }),
      failBeforeRestore: () => commit({ ...base(), health: 'recovery_required', degradation: [] }),
      failCleanup: (transactionId: string) => commit({
        committedTarget: dailyPublished ? null : initial.committedTarget,
        preferredRegion: initial.preferredRegion,
        health: 'recovery_required',
        degradation: [],
        activeTransactionId: transactionId,
      }),
    }),
    /** recover 事务（等价旧 application.recover 的内联提交）。 */
    recover: Object.freeze({
      /** 按日志上下文重建旧状态并发布；degraded 之外的 health 不带 degradation。 */
      publishPrevious: (previousState: TransactionJournalContext['previousState'], health: TransactionJournalContext['previousState']['health']) =>
        commit({
          committedTarget: previousState.committedTarget,
          preferredRegion: previousState.preferredRegion,
          health,
          degradation: health === 'degraded' ? previousState.degradation : [],
          activeTransactionId: null,
        }),
      publishDaily: (transactionId: string, preferredRegion: ProtectionState['preferredRegion']) => commit({
        committedTarget: null,
        preferredRegion,
        health: 'healthy',
        degradation: [],
        activeTransactionId: transactionId,
      }),
      failCleanupDaily: (transactionId: string, preferredRegion: ProtectionState['preferredRegion']) => commit({
        committedTarget: null,
        preferredRegion,
        health: 'recovery_required',
        degradation: [],
        activeTransactionId: transactionId,
      }),
      completeDaily: (preferredRegion: ProtectionState['preferredRegion']) => commit({
        committedTarget: null,
        preferredRegion,
        health: 'healthy',
        degradation: [],
        activeTransactionId: null,
      }),
    }),
  });
}

export type RepositoryStateTransition = ReturnType<typeof createRepositoryStateTransition>;