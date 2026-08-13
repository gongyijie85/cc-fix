import { recoveryAction, type TransactionJournal } from '../state/journal.js';

export type RecoveryDecision =
  | { kind: 'none' }
  | { kind: 'protect_compensation'; transactionId: string }
  | { kind: 'restore_convergence'; transactionId: string };

/** Read-only startup decision; actual mutation remains blocked until this is resolved. */
export function decideRecovery(journal: TransactionJournal | undefined): RecoveryDecision {
  if (journal === undefined || recoveryAction(journal) === 'none') return { kind: 'none' };
  return recoveryAction(journal) === 'reverse_compensation'
    ? { kind: 'protect_compensation', transactionId: journal.transactionId }
    : { kind: 'restore_convergence', transactionId: journal.transactionId };
}
