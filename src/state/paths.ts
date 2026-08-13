import { isAbsolute, join } from 'node:path';

export const STATE_FILE_NAME = 'state.json';
export const BACKUP_FILE_NAME = 'persist-backup.json';
export const MIGRATION_EVIDENCE_DIRECTORY_NAME = 'migration-evidence';
export const TRANSACTION_JOURNAL_FILE_NAME = 'transaction-journal.json';
export const MUTATION_LOCK_FILE_NAME = 'mutation.lock';

export type StatePaths = {
  state: string;
  backup: string;
  migrationEvidence: string;
  journal: string;
  lock: string;
};

export function statePaths(root: string): StatePaths {
  if (!isAbsolute(root) || root.split(/[\\/]+/u).some((segment) => segment === '..')) {
    throw new TypeError('State root must be an absolute literal path');
  }
  return {
    state: join(root, STATE_FILE_NAME),
    backup: join(root, BACKUP_FILE_NAME),
    migrationEvidence: join(root, MIGRATION_EVIDENCE_DIRECTORY_NAME),
    journal: join(root, TRANSACTION_JOURNAL_FILE_NAME),
    lock: join(root, MUTATION_LOCK_FILE_NAME),
  };
}
