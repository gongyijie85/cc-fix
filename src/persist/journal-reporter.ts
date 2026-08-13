import type { ExecutionJournal } from './executor.js';
import { TransactionJournalRepository, type JournalPhase, type TransactionJournal } from '../state/journal.js';
import type { PersistStepId } from './steps.js';

/** Serializes executor phase reports into one durable journal generation. */
export function createJournalReporter(repository: TransactionJournalRepository, initial: TransactionJournal): ExecutionJournal {
  let current = initial;
  return Object.freeze({
    transition: async (id: PersistStepId, phase: Exclude<JournalPhase, 'planned'>) => { current = await repository.transition(current, id, phase); },
  });
}
