import type { ProtectionTarget } from '../domain/protection.js';
import { managedStepIds, type PersistStepId } from './steps.js';
import { desiredValues } from './targets.js';
import { storedValueEquals, type StoredValue } from '../state/schema.js';
import type { JsonValue } from '../state/checksum.js';
import { BackupRepository, StateRepository, type MutationCoordinatorCapability } from '../state/repository.js';
import { TransactionJournalRepository } from '../state/journal.js';
import type { ExecutableAuthority } from './executor.js';
import { backupSnapshotToDailyValues } from './backup-mapper.js';
import { createRepositoryDailySnapshot } from './backup-transaction.js';
import { createRepositoryStateTransaction } from './state-transaction.js';
import { derivePersistStatus, runProtectTransaction, type PersistStatus, type ProtectTransactionResult } from './service.js';
import { withPersistTransactionLock } from './transaction-lock.js';

export type PersistApplicationErrorCode =
  | 'RECOVERY_REQUIRED'
  | 'BACKUP_REQUIRED'
  | 'BACKUP_CONFLICT';

export class PersistApplicationError extends Error {
  constructor(readonly code: PersistApplicationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PersistApplicationError';
  }
}

export type PersistApplicationDependencies = Readonly<{
  root: string;
  coordinator: MutationCoordinatorCapability;
  stateRepository: StateRepository;
  backupRepository: BackupRepository;
  journalRepository: TransactionJournalRepository;
  authorities: Readonly<Record<PersistStepId, ExecutableAuthority>>;
  now?: () => string;
  snapshotId?: () => string;
}>;

function valuesEqual(left: StoredValue<JsonValue>, right: StoredValue<JsonValue>): boolean {
  return storedValueEquals(left, right);
}

function completeValuesEqual(
  left: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>,
  right: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>,
): boolean {
  return (Object.keys(left) as PersistStepId[]).every((id) => valuesEqual(left[id], right[id]));
}

/** The sole application boundary for protected-mode state transitions. */
export class PersistApplicationService {
  constructor(private readonly dependencies: PersistApplicationDependencies) {}

  async status(): Promise<PersistStatus> {
    const [state, journal] = await Promise.all([
      this.dependencies.stateRepository.read(),
      this.dependencies.journalRepository.read(),
    ]);
    return derivePersistStatus(state.value, journal);
  }

  async protect(target: ProtectionTarget): Promise<ProtectTransactionResult> {
    const dependencies = this.dependencies;
    return withPersistTransactionLock(dependencies.root, dependencies.coordinator, 'persist.protect', async () => {
      const [stateRead, journal] = await Promise.all([
        dependencies.stateRepository.read(),
        dependencies.journalRepository.read(),
      ]);
      const status = derivePersistStatus(stateRead.value, journal);
      if (status.health === 'recovery_required' || stateRead.value.activeTransactionId !== null) {
        throw new PersistApplicationError('RECOVERY_REQUIRED', 'The previous persist transaction must be recovered first');
      }

      const desired = desiredValues(target);
      const observed: Partial<Record<PersistStepId, boolean>> = {};
      await Promise.all(managedStepIds(target).map(async (id) => {
        observed[id] = valuesEqual(await dependencies.authorities[id].read(), desired[id]);
      }));

      let dailyValues: Readonly<Record<PersistStepId, StoredValue<JsonValue>>> | undefined;
      if (stateRead.value.committedTarget?.mode === 'deep' && target.mode === 'standard') {
        const backup = await dependencies.backupRepository.read();
        if (backup.kind === 'missing') {
          throw new PersistApplicationError('BACKUP_REQUIRED', 'Deep protection cannot be reduced without the immutable daily backup');
        }
        dailyValues = backupSnapshotToDailyValues(backup.value);
      }

      const ensureDailySnapshot = async (
        captured: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>,
      ): Promise<void> => {
        const existing = await dependencies.backupRepository.read();
        if (existing.kind === 'missing') {
          await createRepositoryDailySnapshot(
            dependencies.backupRepository,
            dependencies.now,
            dependencies.snapshotId,
          )(captured);
          return;
        }
        let existingValues: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>;
        try {
          existingValues = backupSnapshotToDailyValues(existing.value);
        } catch (error) {
          throw new PersistApplicationError('BACKUP_CONFLICT', 'Existing daily backup cannot be used safely', { cause: error });
        }
        if (!completeValuesEqual(existingValues, captured)) {
          throw new PersistApplicationError(
            'BACKUP_CONFLICT',
            'Existing daily backup does not match the current daily authorities',
          );
        }
      };

      return runProtectTransaction({
        committedTarget: stateRead.value.committedTarget,
        requestedTarget: target,
        observed,
        desired,
        dailyValues,
        authorities: dependencies.authorities,
        journalRepository: dependencies.journalRepository,
        createDailySnapshot: ensureDailySnapshot,
        stateTransaction: createRepositoryStateTransaction(
          dependencies.stateRepository,
          stateRead.value,
          target,
        ),
      });
    });
  }
}
