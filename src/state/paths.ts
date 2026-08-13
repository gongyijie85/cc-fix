import { isAbsolute, join } from 'node:path';

export const STATE_FILE_NAME = 'state.json';
export const BACKUP_FILE_NAME = 'persist-backup.json';
export const MIGRATION_EVIDENCE_DIRECTORY_NAME = 'migration-evidence';

export type StatePaths = {
  state: string;
  backup: string;
  migrationEvidence: string;
};

export function statePaths(root: string): StatePaths {
  if (!isAbsolute(root) || root.split(/[\\/]+/u).some((segment) => segment === '..')) {
    throw new TypeError('State root must be an absolute literal path');
  }
  return {
    state: join(root, STATE_FILE_NAME),
    backup: join(root, BACKUP_FILE_NAME),
    migrationEvidence: join(root, MIGRATION_EVIDENCE_DIRECTORY_NAME),
  };
}
