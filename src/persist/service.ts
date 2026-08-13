import type { ProtectionState } from '../state/schema.js';
import type { TransactionJournal } from '../state/journal.js';
import { decideRecovery, type RecoveryDecision } from './recovery.js';
import type { ProtectionTarget } from '../domain/protection.js';
import type { JsonValue } from '../state/checksum.js';
import type { StoredValue } from '../state/schema.js';
import { captureJournalPlan, executePlan, type ExecutableAuthority, type ExecutionResult } from './executor.js';
import { createJournalReporter } from './journal-reporter.js';
import { planTransition, type AuthorityObservation } from './planner.js';
import type { PersistStepId } from './steps.js';
import { TransactionJournalRepository } from '../state/journal.js';

export type PersistStatus = Readonly<{
  mode: 'daily' | 'standard' | 'deep';
  target: ProtectionState['committedTarget'];
  health: ProtectionState['health'];
  transaction: RecoveryDecision;
}>;

/** The backup is deliberately not an input: it is a snapshot, not state. */
export function derivePersistStatus(state: ProtectionState, journal: TransactionJournal | undefined): PersistStatus {
  const transaction = decideRecovery(journal);
  return { mode: state.committedTarget?.mode ?? 'daily', target: state.committedTarget, health: transaction.kind === 'none' ? state.health : 'recovery_required', transaction };
}

export type ProtectTransactionResult = ExecutionResult | Readonly<{ kind: 'noop'; degraded: readonly PersistStepId[] }>;

/**
 * One protection transaction with an explicit commit point. The callback is
 * never invoked until the complete required plan has verified.
 */
export async function runProtectTransaction(input: {
  committedTarget: ProtectionTarget | null;
  requestedTarget: ProtectionTarget;
  observed: AuthorityObservation;
  desired: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>;
  authorities: Readonly<Record<PersistStepId, ExecutableAuthority>>;
  journalRepository: TransactionJournalRepository;
  commit(result: Extract<ExecutionResult, { kind: 'committable' | 'degraded' }>): Promise<void>;
}): Promise<ProtectTransactionResult> {
  const plan = planTransition({ committedTarget: input.committedTarget, requestedTarget: input.requestedTarget, observed: input.observed });
  if (plan.kind === 'noop') return { kind: 'noop', degraded: [] };
  const snapshot = await captureJournalPlan({ steps: plan.steps, desired: input.desired, authorities: input.authorities });
  const journal = await input.journalRepository.plan('protect', snapshot);
  const result = await executePlan({ steps: plan.steps, desired: input.desired, authorities: input.authorities, journal: createJournalReporter(input.journalRepository, journal) });
  if (result.kind === 'committable' || result.kind === 'degraded') await input.commit(result);
  return result;
}
