import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalJson, CheckedEnvelopeError, type JsonValue } from './checksum.js';
import {
  deleteCheckedFile,
  checkedPayloadIdentity,
  DurableFileError,
  nodeDurableFileSystem,
  readCheckedFile,
  writeCheckedFile,
  type BoundarySafetyCapability,
  type DurableFileSystem,
  type DurableDeleteResult,
  type DurableWriteResult,
  type GenerationFailure,
} from './durable-file.js';
import {
  CapabilityError,
  isMutationCoordinatorCapability,
  isRestoreReservation,
  isVerifiedRestoreAuthorityCapability,
  type MutationAuditOperation,
  type MutationCoordinatorCapability,
  type MutationLockContext,
  type RestoreReservation,
  type VerifiedRestoreAuthorityCapability,
  type VerifiedRestoreProof,
  type VerifiedRestoreSnapshot,
} from './internal/capabilities.js';
import { statePaths } from './paths.js';
import {
  cloneImmutable,
  isBackupSnapshotV4,
  isProtectionState,
  isSafeJsonValue,
  type BackupSnapshotV4,
  type DegradationReason,
  type ProtectionState,
} from './schema.js';
import type { ProtectionHealth, ProtectionTarget } from '../domain/protection.js';
import type { RegionCode } from '../domain/region.js';

export { isMutationCoordinatorCapability } from './internal/capabilities.js';
export type { MutationCoordinatorCapability } from './internal/capabilities.js';

const STATE_SCHEMA = 'cc-fix-state-v1';
const BACKUP_SCHEMA = 'cc-fix-backup-v4';

export type RepositoryErrorCode =
  | 'INVALID_STATE'
  | 'STATE_ALREADY_EXISTS'
  | 'STATE_MISSING'
  | 'STATE_CORRUPT'
  | 'REVISION_MISMATCH'
  | 'RECOVERY_REQUIRED'
  | 'INVALID_BACKUP'
  | 'BACKUP_ALREADY_EXISTS'
  | 'BACKUP_MISSING'
  | 'BACKUP_CORRUPT'
  | 'RESTORE_PROOF_INVALID'
  | 'RESTORE_VERIFIER_REQUIRED'
  | 'LOCK_REQUIRED'
  | 'LOCK_REENTRY'
  | 'BACKUP_IDENTITY_MISMATCH'
  | 'DELETE_FAILED'
  | 'IO_FAILED';

export class RepositoryError extends Error {
  constructor(
    readonly code: RepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RepositoryError';
  }
}

export class RestoreReconciliationRequiredError extends RepositoryError {
  readonly reservationState = 'reconcile_required' as const;
  constructor(readonly reservation: RestoreReservation, message: string, options?: ErrorOptions) {
    super('DELETE_FAILED', message, options);
    this.name = 'RestoreReconciliationRequiredError';
  }
}

export type StateMutation = {
  committedTarget: ProtectionTarget | null;
  preferredRegion: RegionCode;
  health: ProtectionHealth;
  degradation: DegradationReason[];
  activeTransactionId: string | null;
};

export type PersistenceResult<T> = DurableWriteResult & { value: T };

export type StateReadResult = {
  value: ProtectionState;
  source: 'current' | 'previous';
  degraded: boolean;
  recoveredFromPredecessor: boolean;
  currentFailure?: GenerationFailure;
};

export type BackupReadResult =
  | { kind: 'missing' }
  | {
      kind: 'value';
      value: BackupSnapshotV4;
      source: 'current' | 'previous';
      degraded: boolean;
      recoveredFromPredecessor: boolean;
      currentFailure?: GenerationFailure;
    };

export type { RestoreReservation, VerifiedRestoreProof, VerifiedRestoreSnapshot };

export type VerifiedBackupDeleteResult = DurableDeleteResult &
  (
    | { reservationState: 'finalized' }
    | { reservationState: 'reconcile_required'; reservation: RestoreReservation }
  );

export type RestoreDeletionReconcileResult =
  | { kind: 'finalized' }
  | { kind: 'preserved_retryable' };

export type RepositoryOptions = {
  root: string;
  filesystem?: DurableFileSystem;
  requiredBoundarySafety?: BoundarySafetyCapability;
  now?: () => string;
  mutationCoordinator?: MutationCoordinatorCapability;
  verifiedRestoreAuthority?: VerifiedRestoreAuthorityCapability;
};

const mutationQueues = new Map<string, Promise<void>>();
const heldMutationScopes = new AsyncLocalStorage<ReadonlySet<string>>();

function mutationKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLocaleLowerCase('en-US') : absolute;
}

function scopeLockKey(root: string, filePath: string): string {
  return `${mutationKey(root)}\0${mutationKey(filePath)}`;
}

/** Serializes mutations across all repository instances in this process. T07 supplies cross-process locking. */
async function withProcessMutationLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const predecessor = mutationQueues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  const tail = predecessor.catch(() => undefined).then(() => turn);
  mutationQueues.set(key, tail);
  await predecessor.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (mutationQueues.get(key) === tail) mutationQueues.delete(key);
  }
}

function asJson(value: ProtectionState | BackupSnapshotV4): JsonValue {
  return value as unknown as JsonValue;
}

export function backupSnapshotFingerprint(snapshot: BackupSnapshotV4): string {
  if (!isBackupSnapshotV4(snapshot)) {
    throw new RepositoryError('INVALID_BACKUP', 'Cannot fingerprint an invalid backup snapshot');
  }
  return createHash('sha256').update(canonicalJson(snapshot as unknown as JsonValue)).digest('hex');
}

class UnknownPayloadSchemaError extends Error {}

function validateStatePayload(payload: JsonValue): payload is JsonValue {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    'schemaVersion' in payload &&
    payload.schemaVersion !== 1
  ) throw new UnknownPayloadSchemaError('Unknown protection state schema version');
  return isProtectionState(payload);
}

function validateBackupPayload(payload: JsonValue): payload is JsonValue {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    'schemaVersion' in payload &&
    payload.schemaVersion !== 4
  ) throw new UnknownPayloadSchemaError('Unknown backup schema version');
  return isBackupSnapshotV4(payload);
}

function isUnknownSchemaFailure(failure: GenerationFailure | undefined): boolean {
  return failure?.cause instanceof UnknownPayloadSchemaError ||
    (failure?.cause instanceof CheckedEnvelopeError && failure.cause.code === 'SCHEMA_MISMATCH');
}

function fromDurableError(
  error: unknown,
  corruptCode: 'STATE_CORRUPT' | 'BACKUP_CORRUPT',
): RepositoryError {
  if (error instanceof RepositoryError) return error;
  if (error instanceof DurableFileError) {
    const code = ['CORRUPT', 'BOTH_INVALID', 'INVALID_PAYLOAD'].includes(error.code)
      ? corruptCode
      : 'IO_FAILED';
    return new RepositoryError(code, `Repository durable file failed: ${error.code}`, {
      cause: error,
    });
  }
  return new RepositoryError('IO_FAILED', 'Repository operation failed', { cause: error });
}

abstract class RepositoryBase {
  protected readonly filesystem: DurableFileSystem;
  protected readonly paths: ReturnType<typeof statePaths>;
  protected readonly requiredBoundarySafety: BoundarySafetyCapability | undefined;
  protected readonly now: () => string;
  protected readonly root: string;
  protected readonly mutationCoordinator: MutationCoordinatorCapability | undefined;
  protected readonly verifiedRestoreAuthority: VerifiedRestoreAuthorityCapability | undefined;

  constructor(options: RepositoryOptions) {
    this.root = options.root;
    this.paths = statePaths(options.root);
    this.filesystem = options.filesystem ?? nodeDurableFileSystem;
    this.requiredBoundarySafety = options.requiredBoundarySafety;
    this.now = options.now ?? (() => new Date().toISOString());
    this.mutationCoordinator = isMutationCoordinatorCapability(options.mutationCoordinator)
      ? options.mutationCoordinator
      : undefined;
    this.verifiedRestoreAuthority = isVerifiedRestoreAuthorityCapability(options.verifiedRestoreAuthority)
      ? options.verifiedRestoreAuthority
      : undefined;
  }

  protected mutate<T>(
    operation: MutationAuditOperation,
    filePath: string,
    action: (lock: MutationLockContext) => Promise<T>,
  ): Promise<T> {
    if (this.mutationCoordinator === undefined) {
      throw new RepositoryError('LOCK_REQUIRED', 'A mutation coordinator is required');
    }
    const request = Object.freeze({
      lockKey: scopeLockKey(this.root, filePath),
      stateRoot: this.root,
      filePath,
      operation,
    });
    return (async () => {
      if (heldMutationScopes.getStore()?.has(request.lockKey) === true) {
        throw new RepositoryError('LOCK_REENTRY', 'Mutation lock reentry is not permitted');
      }
      let lock: MutationLockContext;
      try {
        lock = await this.mutationCoordinator!.acquire(request);
      } catch (error) {
        if (error instanceof CapabilityError && error.code === 'LOCK_REENTRY') {
          throw new RepositoryError('LOCK_REENTRY', 'Mutation lock reentry is not permitted', { cause: error });
        }
        throw new RepositoryError('LOCK_REQUIRED', 'Mutation lock acquisition failed', { cause: error });
      }
      let result: T | undefined;
      let actionError: unknown;
      try {
        const held = new Set(heldMutationScopes.getStore() ?? []);
        held.add(request.lockKey);
        result = await heldMutationScopes.run(
          held,
          () => withProcessMutationLock(request.lockKey, () => action(lock)),
        );
      } catch (error) {
        actionError = error;
      }
      try {
        await lock.release();
      } catch (releaseError) {
        if (actionError !== undefined) {
          throw new RepositoryError('IO_FAILED', 'Mutation and lock release both failed', {
            cause: new AggregateError([actionError, releaseError]),
          });
        }
        throw new RepositoryError('IO_FAILED', 'Mutation lock release failed', { cause: releaseError });
      }
      if (actionError !== undefined) throw actionError;
      return result as T;
    })();
  }
}

export class StateRepository extends RepositoryBase {
  private async readInternal(): Promise<StateReadResult | { kind: 'missing' }> {
    let result;
    try {
      result = await readCheckedFile({
        stateRoot: this.root,
        filePath: this.paths.state,
        schema: STATE_SCHEMA,
        filesystem: this.filesystem,
        requiredBoundarySafety: this.requiredBoundarySafety,
        validatePayload: validateStatePayload,
      });
    } catch (error) {
      throw fromDurableError(error, 'STATE_CORRUPT');
    }
    if (result.kind === 'missing') return result;
    if (result.source === 'previous' && isUnknownSchemaFailure(result.currentFailure)) {
      throw new RepositoryError(
        'STATE_CORRUPT',
        'A newer or unknown protection state schema cannot fall back to a predecessor',
      );
    }
    const value = cloneImmutable(result.payload as unknown as ProtectionState);
    return {
      value,
      source: result.source,
      degraded: result.degraded,
      recoveredFromPredecessor: result.degraded,
      ...(result.currentFailure === undefined ? {} : { currentFailure: result.currentFailure }),
    };
  }

  async read(): Promise<StateReadResult> {
    const result = await this.readInternal();
    if ('kind' in result) throw new RepositoryError('STATE_MISSING', 'Protection state is missing');
    return result;
  }

  async initialize(preferredRegion: RegionCode): Promise<PersistenceResult<ProtectionState>> {
    const state: ProtectionState = {
      schemaVersion: 1,
      revision: 0,
      committedTarget: null,
      preferredRegion,
      health: 'healthy',
      degradation: [],
      activeTransactionId: null,
      updatedAt: this.now(),
    };
    if (!isProtectionState(state)) {
      throw new RepositoryError('INVALID_STATE', 'Initial protection state is invalid');
    }
    const immutable = cloneImmutable(state);
    return this.mutate('state.initialize', this.paths.state, async () => {
      const existing = await this.readInternal();
      if (!('kind' in existing)) {
        throw new RepositoryError('STATE_ALREADY_EXISTS', 'Protection state already exists');
      }
      try {
        const durability = await writeCheckedFile({
          stateRoot: this.root,
          filePath: this.paths.state,
          schema: STATE_SCHEMA,
          filesystem: this.filesystem,
          requiredBoundarySafety: this.requiredBoundarySafety,
          payload: asJson(immutable),
          validatePayload: validateStatePayload,
        });
        return { ...durability, value: immutable };
      } catch (error) {
        throw fromDurableError(error, 'STATE_CORRUPT');
      }
    });
  }

  /** T06 migration-only atomic import. It never publishes an intermediate daily state. */
  async initializeImported(state: ProtectionState): Promise<PersistenceResult<ProtectionState>> {
    if (!isProtectionState(state) || state.revision !== 0) {
      throw new RepositoryError('INVALID_STATE', 'Imported protection state must be a valid initial revision');
    }
    const immutable = cloneImmutable(state);
    return this.mutate('state.initialize', this.paths.state, async () => {
      const existing = await this.readInternal();
      if (!('kind' in existing)) {
        throw new RepositoryError('STATE_ALREADY_EXISTS', 'Protection state already exists');
      }
      try {
        const durability = await writeCheckedFile({
          stateRoot: this.root,
          filePath: this.paths.state,
          schema: STATE_SCHEMA,
          filesystem: this.filesystem,
          requiredBoundarySafety: this.requiredBoundarySafety,
          payload: asJson(immutable),
          validatePayload: validateStatePayload,
        });
        return { ...durability, value: immutable };
      } catch (error) {
        throw fromDurableError(error, 'STATE_CORRUPT');
      }
    });
  }

  async commit(expectedRevision: number, next: StateMutation): Promise<PersistenceResult<ProtectionState>> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new RepositoryError('INVALID_STATE', 'Expected revision must be a nonnegative safe integer');
    }
    if (!isSafeJsonValue(next)) {
      throw new RepositoryError('INVALID_STATE', 'Next protection state contains unsafe values');
    }
    const detachedNext = cloneImmutable(next) as StateMutation;
    return this.mutate('state.commit', this.paths.state, async () => {
      const current = await this.readInternal();
      if ('kind' in current) throw new RepositoryError('STATE_MISSING', 'Protection state is missing');
      if (current.recoveredFromPredecessor) {
        throw new RepositoryError(
          'RECOVERY_REQUIRED',
          'Protection state was recovered from a predecessor and cannot be committed',
        );
      }
      if (current.value.revision !== expectedRevision) {
        throw new RepositoryError('REVISION_MISMATCH', 'Protection state revision does not match');
      }
      if (expectedRevision === Number.MAX_SAFE_INTEGER) {
        throw new RepositoryError('INVALID_STATE', 'Protection state revision cannot be incremented');
      }
      const state: ProtectionState = {
        schemaVersion: 1,
        revision: expectedRevision + 1,
        ...detachedNext,
        updatedAt: this.now(),
      };
      if (!isProtectionState(state)) {
        throw new RepositoryError('INVALID_STATE', 'Next protection state is invalid');
      }
      const immutable = cloneImmutable(state);
      try {
        const durability = await writeCheckedFile({
          stateRoot: this.root,
          filePath: this.paths.state,
          schema: STATE_SCHEMA,
          filesystem: this.filesystem,
          requiredBoundarySafety: this.requiredBoundarySafety,
          payload: asJson(immutable),
          validatePayload: validateStatePayload,
        });
        return { ...durability, value: immutable };
      } catch (error) {
        throw fromDurableError(error, 'STATE_CORRUPT');
      }
    });
  }
}

export class BackupRepository extends RepositoryBase {
  private async readInternal(): Promise<BackupReadResult> {
    let result;
    try {
      result = await readCheckedFile({
        stateRoot: this.root,
        filePath: this.paths.backup,
        schema: BACKUP_SCHEMA,
        filesystem: this.filesystem,
        requiredBoundarySafety: this.requiredBoundarySafety,
        validatePayload: validateBackupPayload,
      });
    } catch (error) {
      throw fromDurableError(error, 'BACKUP_CORRUPT');
    }
    if (result.kind === 'missing') return result;
    if (result.source === 'previous' && isUnknownSchemaFailure(result.currentFailure)) {
      throw new RepositoryError(
        'BACKUP_CORRUPT',
        'A newer or unknown backup schema cannot fall back to a predecessor',
      );
    }
    return {
      kind: 'value',
      value: cloneImmutable(result.payload as unknown as BackupSnapshotV4),
      source: result.source,
      degraded: result.degraded,
      recoveredFromPredecessor: result.degraded,
      ...(result.currentFailure === undefined ? {} : { currentFailure: result.currentFailure }),
    };
  }

  read(): Promise<BackupReadResult> {
    return this.readInternal();
  }

  async create(snapshot: BackupSnapshotV4): Promise<PersistenceResult<BackupSnapshotV4>> {
    if (!isBackupSnapshotV4(snapshot)) {
      throw new RepositoryError('INVALID_BACKUP', 'Backup snapshot does not match schema v4');
    }
    const immutable = cloneImmutable(snapshot);
    return this.mutate('backup.create', this.paths.backup, async () => {
      const existing = await this.readInternal();
      if (existing.kind === 'value') {
        throw new RepositoryError('BACKUP_ALREADY_EXISTS', 'Immutable backup already exists');
      }
      try {
        const durability = await writeCheckedFile({
          stateRoot: this.root,
          filePath: this.paths.backup,
          schema: BACKUP_SCHEMA,
          filesystem: this.filesystem,
          requiredBoundarySafety: this.requiredBoundarySafety,
          payload: asJson(immutable),
          validatePayload: validateBackupPayload,
        });
        return { ...durability, value: immutable };
      } catch (error) {
        throw fromDurableError(error, 'BACKUP_CORRUPT');
      }
    });
  }

  async deleteAfterVerifiedRestore(
    proof: VerifiedRestoreProof,
  ): Promise<VerifiedBackupDeleteResult> {
    if (this.verifiedRestoreAuthority === undefined) {
      throw new RepositoryError(
        'RESTORE_VERIFIER_REQUIRED',
        'A verified restore authority is required to delete the immutable backup',
      );
    }
    const verifiedRestoreAuthority = this.verifiedRestoreAuthority;
    return this.mutate('backup.delete', this.paths.backup, async (lock) => {
      const existing = await this.readInternal();
      if (existing.kind === 'missing') {
        throw new RepositoryError('BACKUP_MISSING', 'Immutable backup is missing');
      }
      const identity = checkedPayloadIdentity(asJson(existing.value));
      const verifiedSnapshot: VerifiedRestoreSnapshot = Object.freeze({ ...identity });
      let reservation: RestoreReservation | undefined;
      try {
        reservation = await verifiedRestoreAuthority.reserve(lock, proof, verifiedSnapshot);
      } catch (error) {
        throw new RepositoryError('RESTORE_PROOF_INVALID', 'Restore proof verification failed', {
          cause: error,
        });
      }
      if (reservation === undefined) {
        throw new RepositoryError('RESTORE_PROOF_INVALID', 'Restore proof rejected');
      }
      let deletion: DurableDeleteResult;
      try {
        deletion = await deleteCheckedFile({
          stateRoot: this.root,
          filePath: this.paths.backup,
          schema: BACKUP_SCHEMA,
          filesystem: this.filesystem,
          requiredBoundarySafety: this.requiredBoundarySafety,
          validatePayload: validateBackupPayload,
          expectedIdentity: identity,
        });
      } catch (error) {
        try {
          await verifiedRestoreAuthority.abort(lock, reservation);
        } catch (abortError) {
          throw new RestoreReconciliationRequiredError(reservation, 'Deletion failed and reservation abort requires reconciliation', {
            cause: new AggregateError([error, abortError]),
          });
        }
        throw new RepositoryError('DELETE_FAILED', 'Verified backup deletion failed', { cause: error });
      }
      if (deletion.committed && !deletion.possiblyDeleted) {
        try {
          await verifiedRestoreAuthority.finalize(lock, reservation);
        } catch {
          return {
            ...deletion,
            reservationState: 'reconcile_required',
            reservation,
          };
        }
        return { ...deletion, reservationState: 'finalized' };
      }
      return {
        ...deletion,
        reservationState: 'reconcile_required',
        reservation,
      };
    });
  }

  async reconcileVerifiedRestoreDeletion(
    reservation: RestoreReservation,
  ): Promise<RestoreDeletionReconcileResult> {
    if (this.verifiedRestoreAuthority === undefined) {
      throw new RepositoryError(
        'RESTORE_VERIFIER_REQUIRED',
        'A verified restore authority is required to reconcile backup deletion',
      );
    }
    if (!isRestoreReservation(reservation)) {
      throw new RepositoryError('RESTORE_PROOF_INVALID', 'Restore reservation is invalid');
    }
    if (reservation.lockKey !== scopeLockKey(this.root, this.paths.backup)) {
      throw new RepositoryError(
        'BACKUP_IDENTITY_MISMATCH',
        'Restore reservation belongs to a different backup lock identity',
      );
    }
    const authority = this.verifiedRestoreAuthority;
    return this.mutate('backup.reconcile_delete', this.paths.backup, async (lock) => {
      const existing = await this.readInternal();
      try {
        if (existing.kind === 'missing') {
          await authority.finalize(lock, reservation);
          return { kind: 'finalized' };
        }
        const identity = checkedPayloadIdentity(asJson(existing.value));
        if (
          identity.snapshotId !== reservation.snapshot.snapshotId ||
          identity.payloadFingerprint !== reservation.snapshot.payloadFingerprint ||
          identity.generationIdentity !== reservation.snapshot.generationIdentity
        ) {
          throw new RepositoryError(
            'BACKUP_IDENTITY_MISMATCH',
            'Backup identity changed while deletion required reconciliation',
          );
        }
        await authority.abort(lock, reservation);
        return { kind: 'preserved_retryable' };
      } catch (error) {
        if (error instanceof RepositoryError) throw error;
        throw new RepositoryError('RESTORE_PROOF_INVALID', 'Restore reservation reconciliation failed', {
          cause: error,
        });
      }
    });
  }
}
