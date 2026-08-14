import type { JsonValue } from '../../../state/checksum.js';
import { TransactionJournalRepository, type JournalStep, type TransactionJournal } from '../../../state/journal.js';
import { isSafeJsonValue, isStoredValue, storedValueEquals, type StoredValue } from '../../../state/schema.js';
import type { ExecutableAuthority } from './executor.js';
import { applyDailyStep } from './restore.js';
import { ALL_STEP_IDS, type PersistStepId } from '../../steps.js';

export type RecoveryExecutionResult = Readonly<{
  kind: 'recovered' | 'recovery_required';
  failed: readonly PersistStepId[];
}>;

function stepId(step: JournalStep): PersistStepId | undefined {
  return ALL_STEP_IDS.includes(step.id as PersistStepId) ? step.id as PersistStepId : undefined;
}

function stored(input: JsonValue | undefined): StoredValue<JsonValue> | undefined {
  return input !== undefined && isStoredValue(input, isSafeJsonValue) ? input : undefined;
}

async function markRecoveryRequired(
  repository: TransactionJournalRepository,
  journal: TransactionJournal,
  id: PersistStepId,
): Promise<TransactionJournal> {
  const current = journal.steps.find((step) => step.id === id);
  if (current?.phase === 'recovery_required') return journal;
  try { return await repository.transition(journal, id, 'recovery_required'); }
  catch { return journal; }
}

/** Reverse-compensates every possibly modified protect step; planned steps need no write. */
export async function recoverProtectTransaction(input: {
  journal: TransactionJournal;
  journalRepository: TransactionJournalRepository;
  authorities: Readonly<Record<PersistStepId, ExecutableAuthority>>;
}): Promise<RecoveryExecutionResult> {
  if (input.journal.kind !== 'protect') throw new Error('Protect recovery requires a protect journal');
  let journal = input.journal;
  const failed: PersistStepId[] = [];
  for (const entry of [...journal.steps].reverse()) {
    const id = stepId(entry);
    if (id === undefined || entry.phase === 'compensated') continue;
    if (entry.phase === 'planned') {
      try { journal = await input.journalRepository.transition(journal, id, 'compensated'); }
      catch { failed.push(id); journal = await markRecoveryRequired(input.journalRepository, journal, id); }
      continue;
    }
    const original = stored(entry.original);
    if (original === undefined) {
      failed.push(id);
      journal = await markRecoveryRequired(input.journalRepository, journal, id);
      continue;
    }
    try {
      const phase = journal.steps.find((step) => step.id === id)!.phase;
      if (phase !== 'compensating') journal = await input.journalRepository.transition(journal, id, 'compensating');
      const outcome = await input.authorities[id].write(original);
      if (outcome !== undefined) throw new Error(`Compensation write denied on ${id}`);
      const actual = await input.authorities[id].read();
      if (!storedValueEquals(actual, original)) throw new Error('Compensation readback mismatch');
      journal = await input.journalRepository.transition(journal, id, 'compensated');
    } catch {
      failed.push(id);
      journal = await markRecoveryRequired(input.journalRepository, journal, id);
    }
  }
  return { kind: failed.length === 0 ? 'recovered' : 'recovery_required', failed };
}

/** Re-applies and verifies all daily authorities, including previously verified steps that may have drifted. */
export async function recoverRestoreAuthorities(input: {
  journal: TransactionJournal;
  journalRepository: TransactionJournalRepository;
  daily: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>;
  authorities: Readonly<Record<PersistStepId, ExecutableAuthority>>;
}): Promise<RecoveryExecutionResult> {
  if (input.journal.kind !== 'restore') throw new Error('Restore recovery requires a restore journal');
  let journal = input.journal;
  const failed: PersistStepId[] = [];
  for (const id of ALL_STEP_IDS) {
    const entry = journal.steps.find((step) => step.id === id);
    if (entry === undefined || entry.phase === 'compensated' || entry.phase === 'compensating') {
      failed.push(id);
      continue;
    }
    const actual = await input.authorities[id].read();
    const outcome = await applyDailyStep({
      id,
      daily: input.daily[id],
      authority: input.authorities[id],
      write: !storedValueEquals(actual, input.daily[id]),
      beginTransition: async () => {
        // verified 的已对齐步骤不重开（与旧实现一致）；其余阶段一律先推进到 applying。
        if (entry.phase !== 'applying' && entry.phase !== 'verified') {
          journal = await input.journalRepository.transition(journal, id, 'applying');
        }
      },
      reportVerified: async () => {
        if (journal.steps.find((step) => step.id === id)!.phase !== 'verified') {
          journal = await input.journalRepository.transition(journal, id, 'verified');
        }
      },
      reportFailure: async () => { journal = await markRecoveryRequired(input.journalRepository, journal, id); },
    });
    if (outcome === 'failed') failed.push(id);
  }
  return { kind: failed.length === 0 ? 'recovered' : 'recovery_required', failed };
}
