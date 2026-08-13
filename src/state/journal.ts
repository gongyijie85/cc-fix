import { randomUUID } from 'node:crypto';
import { readCheckedFile, writeCheckedFile, type DurableFileSystem } from './durable-file.js';
import type { JsonValue } from './checksum.js';

export const TRANSACTION_JOURNAL_SCHEMA = 'cc-fix-transaction-journal-v1';
export type JournalPhase = 'planned' | 'applying' | 'verified' | 'compensating' | 'compensated' | 'recovery_required';
export type JournalStep = { id: string; phase: JournalPhase };
export type TransactionJournal = {
  transactionId: string;
  kind: 'protect' | 'restore';
  steps: JournalStep[];
};

function validJournal(value: JsonValue): value is TransactionJournal {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof value.transactionId === 'string' && (value.kind === 'protect' || value.kind === 'restore')
    && Array.isArray(value.steps) && value.steps.every((step) => typeof step === 'object' && step !== null && !Array.isArray(step)
      && typeof step.id === 'string' && ['planned','applying','verified','compensating','compensated','recovery_required'].includes(String(step.phase)));
}

export class TransactionJournalRepository {
  constructor(private readonly root: string, private readonly path: string, private readonly filesystem?: DurableFileSystem) {}
  async read(): Promise<TransactionJournal | undefined> {
    const result = await readCheckedFile<TransactionJournal>({ stateRoot: this.root, filePath: this.path, schema: TRANSACTION_JOURNAL_SCHEMA, filesystem: this.filesystem, validatePayload: validJournal });
    return result.kind === 'missing' ? undefined : result.payload;
  }
  async plan(kind: TransactionJournal['kind'], ids: readonly string[]): Promise<TransactionJournal> {
    if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error('A journal plan needs unique steps');
    const journal: TransactionJournal = { transactionId: randomUUID(), kind, steps: ids.map((id) => ({ id, phase: 'planned' })) };
    await writeCheckedFile({ stateRoot: this.root, filePath: this.path, schema: TRANSACTION_JOURNAL_SCHEMA, filesystem: this.filesystem, payload: journal, validatePayload: validJournal });
    return journal;
  }
  async transition(journal: TransactionJournal, id: string, phase: JournalPhase): Promise<TransactionJournal> {
    const index = journal.steps.findIndex((step) => step.id === id);
    if (index < 0) throw new Error('Journal step is not planned');
    const next: TransactionJournal = { ...journal, steps: journal.steps.map((step, i) => i === index ? { ...step, phase } : { ...step }) };
    await writeCheckedFile({ stateRoot: this.root, filePath: this.path, schema: TRANSACTION_JOURNAL_SCHEMA, filesystem: this.filesystem, payload: next, validatePayload: validJournal });
    return next;
  }
}
