import type { ProtectionState } from '../state/schema.js';
import type { TransactionJournal } from '../state/journal.js';
import { decideRecovery, type RecoveryDecision } from './recovery.js';

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
