import type { DegradationReason, ProtectionState } from '../../../state/schema.js';
import type { TransactionJournal, TransactionJournalContext } from '../../../state/journal.js';
import { decideRecovery, type RecoveryDecision } from './recovery.js';
import type { ProtectionTarget } from '../../../domain/protection.js';
import type { JsonValue } from '../../../state/checksum.js';
import type { StoredValue } from '../../../state/schema.js';
import { captureDailyAuthorityValues, captureJournalPlan, executePlan, type ExecutableAuthority, type ExecutionResult } from './executor.js';
import { createJournalReporter } from './journal-reporter.js';
import { planTransition, type AuthorityObservation } from './planner.js';
import type { PersistStepId } from '../../steps.js';
import { TransactionJournalRepository } from '../../../state/journal.js';

export type PersistStatus = Readonly<{
  mode: 'daily' | 'standard' | 'deep';
  target: ProtectionState['committedTarget'];
  preferredRegion: ProtectionState['preferredRegion'];
  health: ProtectionState['health'];
  degradation: readonly DegradationReason[];
  transaction: RecoveryDecision | Readonly<{ kind: 'state_reconciliation'; transactionId: string }>;
}>;

/** The backup is deliberately not an input: it is a snapshot, not state. */
export function derivePersistStatus(state: ProtectionState, journal: TransactionJournal | undefined): PersistStatus {
  const transaction = decideRecovery(journal);
  const effectiveTransaction = transaction.kind === 'none' && state.activeTransactionId !== null
    ? { kind: 'state_reconciliation' as const, transactionId: state.activeTransactionId }
    : transaction;
  return {
    mode: state.committedTarget?.mode ?? 'daily',
    target: state.committedTarget,
    preferredRegion: state.preferredRegion,
    health: effectiveTransaction.kind === 'none' ? state.health : 'recovery_required',
    degradation: state.degradation,
    transaction: effectiveTransaction,
  };
}

export type ProtectTransactionResult = ExecutionResult | Readonly<{ kind: 'noop'; degraded: readonly [] }>;

/**
 * One protection transaction with an explicit commit point. The callback is
 * never invoked until the complete required plan has verified.
 */
export async function runProtectTransaction(input: {
  committedTarget: ProtectionTarget | null;
  requestedTarget: ProtectionTarget;
  observed: AuthorityObservation;
  desired: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>;
  dailyValues?: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>;
  authorities: Readonly<Record<PersistStepId, ExecutableAuthority>>;
  journalRepository: TransactionJournalRepository;
  journalContext?: TransactionJournalContext;
  createDailySnapshot?(values: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>): Promise<void>;
  stateTransaction: {
    begin(transactionId: string): Promise<void>;
    complete(result: Extract<ExecutionResult, { kind: 'committable' | 'degraded' }>): Promise<void>;
    fail(result: Extract<ExecutionResult, { kind: 'compensated' | 'recovery_required' }>): Promise<void>;
  };
}): Promise<ProtectTransactionResult> {
  const plan = planTransition({ committedTarget: input.committedTarget, requestedTarget: input.requestedTarget, observed: input.observed });
  if (plan.kind === 'noop') return { kind: 'noop', degraded: [] };
  if (input.committedTarget === null) {
    if (input.createDailySnapshot === undefined) throw new Error('Daily snapshot creation is required for initial protection');
    await input.createDailySnapshot(await captureDailyAuthorityValues(input.authorities));
  }
  const effectiveDesired = { ...input.desired };
  for (const step of plan.steps) {
    if (step.action !== 'restore') continue;
    if (input.dailyValues === undefined) throw new Error('Daily snapshot values are required for a downshift');
    effectiveDesired[step.id] = input.dailyValues[step.id];
  }
  const snapshot = await captureJournalPlan({ steps: plan.steps, desired: effectiveDesired, authorities: input.authorities });
  const journal = await input.journalRepository.plan('protect', snapshot, input.journalContext);
  await input.stateTransaction.begin(journal.transactionId);
  const result = await executePlan({ steps: plan.steps, desired: effectiveDesired, authorities: input.authorities, journal: createJournalReporter(input.journalRepository, journal) });
  if (result.kind === 'committable' || result.kind === 'degraded') await input.stateTransaction.complete(result);
  else await input.stateTransaction.fail(result);
  return result;
}