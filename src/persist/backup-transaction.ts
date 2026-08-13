import type { JsonValue } from '../state/checksum.js';
import type { StoredValue } from '../state/schema.js';
import { BackupRepository } from '../state/repository.js';
import type { PersistStepId } from './steps.js';
import { createBackupSnapshotV4 } from './backup-mapper.js';

export function createRepositoryDailySnapshot(
  repository: BackupRepository,
  now: () => string = () => new Date().toISOString(),
  snapshotId?: () => string,
) {
  return async (values: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>) => {
    const snapshot = createBackupSnapshotV4(values, now(), snapshotId?.());
    await repository.create(snapshot);
  };
}
