import type { ProtectionTarget } from '../../domain/protection.js';
import { managedStepIds, type PersistStepId } from '../steps.js';
import { desiredValues } from '../targets.js';
import { storedValueEquals, type BackupSnapshotV4, type StoredValue } from '../../state/schema.js';
import type { JsonValue } from '../../state/checksum.js';
import { BackupRepository, StateRepository, type MutationCoordinatorCapability } from '../../state/repository.js';
import { recoveryAction, TransactionJournalRepository, type TransactionJournalContext } from '../../state/journal.js';
import type { ExecutableAuthority } from '../authority.js';
import { backupSnapshotToDailyValues } from '../backup-mapper.js';
import { createRepositoryDailySnapshot } from './internal/daily-snapshot.js';
import { derivePersistStatus, runProtectTransaction, type PersistStatus, type ProtectTransactionResult } from './internal/service.js';
import { captureDailyAuthorityValues } from './internal/executor.js';
export { derivePersistStatus } from './internal/service.js';
export type { PersistStatus, ProtectTransactionResult } from './internal/service.js';
export type { RestoreTransactionResult } from './internal/restore-service.js';
import { withPersistTransactionLock } from './internal/transaction-lock.js';
import { runRestoreTransaction, type RestoreTransactionResult } from './internal/restore-service.js';
import { recoverProtectTransaction, recoverRestoreAuthorities } from './internal/recovery-executor.js';
import { createRepositoryStateTransition } from './internal/state-transition.js';
import { convergeBackupCleanup } from './internal/backup-cleanup.js';

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

/**
 * 修复事务模块（ADR-0012）：保护态转换的唯一生命周期实现。
 * 公开接口 status / protect / restore / recover；plan / capture / execute / 补偿 /
 * 状态提交编舞全部位于内部细缝，不对外暴露。
 */
export function createPersistTransactionModule(dependencies: PersistApplicationDependencies) {
  const status = async (): Promise<PersistStatus> => {
    const [state, journal] = await Promise.all([
      dependencies.stateRepository.read(),
      dependencies.journalRepository.read(),
    ]);
    return derivePersistStatus(state.value, journal);
  };

  const protect = async (target: ProtectionTarget): Promise<ProtectTransactionResult> => {
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
      // 候选 4：锁内一次性读全部六权威，观察值 / 日志原值 / 日常快照复用同一批读取
      const currentValues = await captureDailyAuthorityValues(dependencies.authorities);
      const observed: Partial<Record<PersistStepId, boolean>> = {};
      for (const id of managedStepIds(target)) {
        observed[id] = valuesEqual(currentValues[id], desired[id]);
      }

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
        ...(dailyValues === undefined ? {} : { dailyValues }),
        authorities: dependencies.authorities,
        snapshotValues: currentValues,
        originals: currentValues,
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
        stateTransaction: createRepositoryStateTransition(
          dependencies.stateRepository,
          stateRead.value,
          target,
        ).protect,
      });
    });
  };

  const restore = async (): Promise<RestoreTransactionResult> => {
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
        stateTransaction: createRepositoryStateTransition(
          dependencies.stateRepository,
          stateRead.value,
        ).restore,
      });
    });
  };

  const recover = async (): Promise<PersistRecoveryResult> => {
    return withPersistTransactionLock(dependencies.root, dependencies.coordinator, 'persist.recover', async () => {
      const stateRead = await dependencies.stateRepository.read();
      const state = stateRead.value;
      const journalRead = await dependencies.journalRepository.readWithDegradation();
      let journal = journalRead.journal;
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
      // 状态提交编舞委托唯一实现（ADR-0012 T-a），本路径不再手写 revision 追踪。
      const transition = createRepositoryStateTransition(dependencies.stateRepository, stateRead.value);

      if (journal.kind === 'protect') {
        const result = await recoverProtectTransaction({
          journal,
          journalRepository: dependencies.journalRepository,
          authorities: dependencies.authorities,
          // issue #57：journal 走 .prev 回退时 phase 滞后于崩溃现场，恢复按最保守解释执行。
          journalDegraded: journalRead.degraded,
        });
        if (result.kind === 'recovered') {
          await transition.recover.publishPrevious(context.previousState, context.previousState.health);
          return { kind: 'recovered', failed: [] };
        }
        await transition.recover.publishPrevious(context.previousState, 'recovery_required');
        return { kind: 'recovery_required', failed: result.failed };
      }

      const backup = await dependencies.backupRepository.read();
      const initialCleanupPhase = journal.steps.find((step) => step.id === 'backup_cleanup')?.phase;
      if (backup.kind === 'missing') {
        if (initialCleanupPhase === undefined || !['applying', 'verified', 'recovery_required'].includes(initialCleanupPhase)) {
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
          await transition.recover.publishPrevious(context.previousState, 'recovery_required');
          return { kind: 'recovery_required', failed: result.failed };
        }
      }

      if (state.committedTarget !== null || state.activeTransactionId !== journal.transactionId) {
        await transition.recover.publishDaily(journal.transactionId, context.previousState.preferredRegion);
      }
      journal = (await dependencies.journalRepository.read())!;
      const cleanup = await convergeBackupCleanup({
        journal,
        journalRepository: dependencies.journalRepository,
        ...(backup.kind === 'value'
          ? {
              deleteDailySnapshot: () => {
                if (dependencies.deleteDailySnapshot === undefined) {
                  throw new PersistApplicationError('DELETE_BACKEND_REQUIRED', 'Verified native backup deletion is unavailable');
                }
                return dependencies.deleteDailySnapshot(backup.value);
              },
            }
          : {}),
        assertPreconditions: () => {
          const phase = journal.steps.find((step) => step.id === 'backup_cleanup')?.phase;
          if (phase === 'verified' && backup.kind === 'value') {
            throw new PersistApplicationError(
              'RECOVERY_CONTEXT_INVALID',
              'Restore journal says backup cleanup verified but the immutable backup still exists',
            );
          }
        },
      });
      if (cleanup.kind === 'recovery_required') {
        await transition.recover.failCleanupDaily(journal.transactionId, context.previousState.preferredRegion);
        return { kind: 'recovery_required', failed: ['backup_cleanup'] };
      }
      await transition.recover.completeDaily(context.previousState.preferredRegion);
      return { kind: 'recovered', failed: [] };
    });
  };

  return Object.freeze({ status, protect, restore, recover });
}

export type PersistTransactionModule = ReturnType<typeof createPersistTransactionModule>;
