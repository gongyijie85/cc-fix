import type { ProtectionTarget } from '../domain/protection.js';
import { managedStepIds, type PersistStepId } from './steps.js';
import { desiredValues } from './targets.js';
import { storedValueEquals, type BackupSnapshotV4, type StoredValue } from '../state/schema.js';
import type { JsonValue } from '../state/checksum.js';
import { BackupRepository, StateRepository, type MutationCoordinatorCapability } from '../state/repository.js';
import { recoveryAction, TransactionJournalRepository, type TransactionJournalContext } from '../state/journal.js';
import type { ExecutableAuthority } from './executor.js';
import { backupSnapshotToDailyValues } from './backup-mapper.js';
import { createRepositoryDailySnapshot } from './backup-transaction.js';
import { createRepositoryStateTransaction } from './state-transaction.js';
import { derivePersistStatus, runProtectTransaction, type PersistStatus, type ProtectTransactionResult } from './service.js';
import { withPersistTransactionLock } from './transaction-lock.js';
import { runRestoreTransaction, type RestoreTransactionResult } from './restore-service.js';
import { createRepositoryRestoreStateTransaction } from './restore-state-transaction.js';
import { recoverProtectTransaction, recoverRestoreAuthorities } from './recovery-executor.js';

export type PersistApplicationErrorCode =
  | 'RECOVERY_REQUIRED'
  | 'BACKUP_REQUIRED'
  | 'BACKUP_CONFLICT'
  | 'DELETE_BACKEND_REQUIRED'
  | 'RECOVERY_CONTEXT_INVALID';

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
  deleteDailySnapshot?: (snapshot: BackupSnapshotV4) => Promise<void>;
}>;

export type PersistRecoveryResult = Readonly<{
  kind: 'noop' | 'recovered' | 'recovery_required';
  failed: readonly string[];
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
        journalContext: {
          previousState: {
            committedTarget: stateRead.value.committedTarget,
            preferredRegion: stateRead.value.preferredRegion,
            health: stateRead.value.health,
            degradation: stateRead.value.degradation,
          },
          requestedTarget: target,
        },
        createDailySnapshot: ensureDailySnapshot,
        stateTransaction: createRepositoryStateTransaction(
          dependencies.stateRepository,
          stateRead.value,
          target,
        ),
      });
    });
  }

  async restore(): Promise<RestoreTransactionResult> {
    const dependencies = this.dependencies;
    return withPersistTransactionLock(dependencies.root, dependencies.coordinator, 'persist.restore', async () => {
      const [stateRead, journal] = await Promise.all([
        dependencies.stateRepository.read(),
        dependencies.journalRepository.read(),
      ]);
      if (stateRead.value.committedTarget === null && stateRead.value.activeTransactionId === null) {
        return { kind: 'noop' };
      }
      const status = derivePersistStatus(stateRead.value, journal);
      if (status.health === 'recovery_required' || stateRead.value.activeTransactionId !== null) {
        throw new PersistApplicationError('RECOVERY_REQUIRED', 'The previous persist transaction must be recovered first');
      }
      const backup = await dependencies.backupRepository.read();
      if (backup.kind === 'missing') {
        throw new PersistApplicationError('BACKUP_REQUIRED', 'Protected mode cannot be restored without the immutable daily backup');
      }
      if (dependencies.deleteDailySnapshot === undefined) {
        throw new PersistApplicationError(
          'DELETE_BACKEND_REQUIRED',
          'Verified native backup deletion is unavailable',
        );
      }
      const daily = backupSnapshotToDailyValues(backup.value);
      return runRestoreTransaction({
        protected: true,
        daily,
        authorities: dependencies.authorities,
        journalRepository: dependencies.journalRepository,
        journalContext: {
          previousState: {
            committedTarget: stateRead.value.committedTarget,
            preferredRegion: stateRead.value.preferredRegion,
            health: stateRead.value.health,
            degradation: stateRead.value.degradation,
          },
          requestedTarget: null,
        },
        deleteDailySnapshot: () => dependencies.deleteDailySnapshot!(backup.value),
        stateTransaction: createRepositoryRestoreStateTransaction(
          dependencies.stateRepository,
          stateRead.value,
        ),
      });
    });
  }

  async recover(): Promise<PersistRecoveryResult> {
    const dependencies = this.dependencies;
    return withPersistTransactionLock(dependencies.root, dependencies.coordinator, 'persist.recover', async () => {
      let state = (await dependencies.stateRepository.read()).value;
      let journal = await dependencies.journalRepository.read();
      if (journal === undefined) {
        if (state.activeTransactionId === null && state.health !== 'recovery_required') {
          return { kind: 'noop', failed: [] };
        }
        throw new PersistApplicationError('RECOVERY_CONTEXT_INVALID', 'Recovery journal is missing');
      }
      if (recoveryAction(journal) === 'none' && state.activeTransactionId === null && state.health !== 'recovery_required') {
        return { kind: 'noop', failed: [] };
      }
      if (journal.context === undefined ||
        (state.activeTransactionId !== null && state.activeTransactionId !== journal.transactionId)) {
        throw new PersistApplicationError('RECOVERY_CONTEXT_INVALID', 'Recovery journal context does not match state');
      }
      const context: TransactionJournalContext = journal.context;
      const commit = async (next: Parameters<StateRepository['commit']>[1]) => {
        const result = await dependencies.stateRepository.commit(state.revision, next);
        state = result.value;
      };
      const previousState = (health: TransactionJournalContext['previousState']['health']) => ({
        committedTarget: context.previousState.committedTarget,
        preferredRegion: context.previousState.preferredRegion,
        health,
        degradation: health === 'degraded' ? context.previousState.degradation : [],
        activeTransactionId: null,
      });

      if (journal.kind === 'protect') {
        const result = await recoverProtectTransaction({
          journal,
          journalRepository: dependencies.journalRepository,
          authorities: dependencies.authorities,
        });
        if (result.kind === 'recovered') {
          await commit(previousState(context.previousState.health));
          return { kind: 'recovered', failed: [] };
        }
        await commit(previousState('recovery_required'));
        return { kind: 'recovery_required', failed: result.failed };
      }

      const backup = await dependencies.backupRepository.read();
      const cleanup = journal.steps.find((step) => step.id === 'backup_cleanup');
      if (backup.kind === 'missing') {
        if (cleanup === undefined || !['applying', 'verified', 'recovery_required'].includes(cleanup.phase)) {
          throw new PersistApplicationError('BACKUP_REQUIRED', 'Restore recovery requires the immutable daily backup');
        }
        if (state.committedTarget !== null) {
          throw new PersistApplicationError(
            'RECOVERY_CONTEXT_INVALID',
            'A missing restore backup is only safe after daily state was published',
          );
        }
      } else {
        const result = await recoverRestoreAuthorities({
          journal,
          journalRepository: dependencies.journalRepository,
          daily: backupSnapshotToDailyValues(backup.value),
          authorities: dependencies.authorities,
        });
        if (result.kind === 'recovery_required') {
          await commit({
            committedTarget: context.previousState.committedTarget,
            preferredRegion: context.previousState.preferredRegion,
            health: 'recovery_required',
            degradation: [],
            activeTransactionId: null,
          });
          return { kind: 'recovery_required', failed: result.failed };
        }
      }

      if (state.committedTarget !== null || state.activeTransactionId !== journal.transactionId) {
        await commit({
          committedTarget: null,
          preferredRegion: context.previousState.preferredRegion,
          health: 'healthy',
          degradation: [],
          activeTransactionId: journal.transactionId,
        });
      }
      journal = (await dependencies.journalRepository.read())!;
      let cleanupPhase = journal.steps.find((step) => step.id === 'backup_cleanup')?.phase;
      try {
        if (cleanupPhase === 'verified' && backup.kind === 'value') {
          throw new PersistApplicationError(
            'RECOVERY_CONTEXT_INVALID',
            'Restore journal says backup cleanup verified but the immutable backup still exists',
          );
        }
        if (cleanupPhase !== 'verified') {
          if (cleanupPhase !== 'applying') {
            journal = await dependencies.journalRepository.transition(journal, 'backup_cleanup', 'applying');
          }
          if (backup.kind === 'value') {
            if (dependencies.deleteDailySnapshot === undefined) {
              throw new PersistApplicationError('DELETE_BACKEND_REQUIRED', 'Verified native backup deletion is unavailable');
            }
            await dependencies.deleteDailySnapshot(backup.value);
          }
          journal = (await dependencies.journalRepository.read())!;
          cleanupPhase = journal.steps.find((step) => step.id === 'backup_cleanup')?.phase;
          if (cleanupPhase !== 'verified') {
            await dependencies.journalRepository.transition(journal, 'backup_cleanup', 'verified');
          }
        }
      } catch {
        journal = (await dependencies.journalRepository.read())!;
        cleanupPhase = journal.steps.find((step) => step.id === 'backup_cleanup')?.phase;
        if (cleanupPhase !== 'recovery_required') {
          try { await dependencies.journalRepository.transition(journal, 'backup_cleanup', 'recovery_required'); } catch {}
        }
        await commit({
          committedTarget: null,
          preferredRegion: context.previousState.preferredRegion,
          health: 'recovery_required',
          degradation: [],
          activeTransactionId: journal.transactionId,
        });
        return { kind: 'recovery_required', failed: ['backup_cleanup'] };
      }
      await commit({
        committedTarget: null,
        preferredRegion: context.previousState.preferredRegion,
        health: 'healthy',
        degradation: [],
        activeTransactionId: null,
      });
      return { kind: 'recovered', failed: [] };
    });
  }
}
