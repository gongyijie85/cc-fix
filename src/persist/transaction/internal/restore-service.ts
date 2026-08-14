import type { JsonValue } from '../../../state/checksum.js';
import { TransactionJournalRepository, type TransactionJournalContext } from '../../../state/journal.js';
import type { StoredValue } from '../../../state/schema.js';
import { captureJournalPlan, type ExecutableAuthority } from './executor.js';
import { createJournalReporter } from './journal-reporter.js';
import { convergeBackupCleanup } from './backup-cleanup.js';
import { restoreAll } from './restore.js';
import { ALL_STEP_IDS, type PersistStepId } from '../../steps.js';

export type RestoreTransactionResult =
  | Readonly<{ kind: 'noop' }>
  | Readonly<{ kind: 'restored' }>
  | Readonly<{ kind: 'recovery_required'; failed: readonly (PersistStepId | 'backup_cleanup')[] }>;

/** Full restore transaction. Backup cleanup is journaled after all authorities verify. */
export async function runRestoreTransaction(input: {
  protected: boolean;
  daily: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>;
  authorities: Readonly<Record<PersistStepId, ExecutableAuthority>>;
  journalRepository: TransactionJournalRepository;
  journalContext?: TransactionJournalContext;
  deleteDailySnapshot(): Promise<void>;
  stateTransaction: {
    begin(transactionId: string): Promise<void>;
    restored(transactionId: string): Promise<void>;
    complete(): Promise<void>;
    failBeforeRestore(): Promise<void>;
    failCleanup(transactionId: string): Promise<void>;
  };
}): Promise<RestoreTransactionResult> {
  if (!input.protected) return { kind: 'noop' };
  const authoritySteps = ALL_STEP_IDS.map((id) => ({ id, disposition: 'required' as const, action: 'restore' as const }));
  const captured = await captureJournalPlan({ steps: authoritySteps, desired: input.daily, authorities: input.authorities });
  const journal = await input.journalRepository.plan('restore', [
    ...captured,
    { id: 'backup_cleanup' },
  ], input.journalContext);
  await input.stateTransaction.begin(journal.transactionId);
  const restored = await restoreAll({
    order: ALL_STEP_IDS,
    daily: input.daily,
    authorities: input.authorities,
    journal: createJournalReporter(input.journalRepository, journal),
  });
  if (restored.failed.length > 0) {
    await input.stateTransaction.failBeforeRestore();
    return { kind: 'recovery_required', failed: restored.failed };
  }
  await input.stateTransaction.restored(journal.transactionId);
  const current = await input.journalRepository.read();
  if (current === undefined) throw new Error('Restore journal disappeared before backup cleanup');
  const cleanup = await convergeBackupCleanup({
    journal: current,
    journalRepository: input.journalRepository,
    deleteDailySnapshot: input.deleteDailySnapshot,
  });
  if (cleanup.kind === 'recovery_required') {
    await input.stateTransaction.failCleanup(journal.transactionId);
    return { kind: 'recovery_required', failed: ['backup_cleanup'] };
  }
  await input.stateTransaction.complete();
  return { kind: 'restored' };
}