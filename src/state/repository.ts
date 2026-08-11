import { resolve } from 'node:path';
import type { JsonValue } from './checksum.js';
import { CheckedEnvelopeError } from './checksum.js';
import {
  deleteCheckedFile,
  DurableFileError,
  nodeDurableFileSystem,
  readCheckedFile,
  writeCheckedFile,
  type BoundarySafetyCapability,
  type DurableFileSystem,
  type DurableWriteResult,
  type GenerationFailure,
} from './durable-file.js';
import { statePaths } from './paths.js';
import {
  cloneImmutable,
  isBackupSnapshotV4,
  isProtectionState,
  isRestoreVerificationReceipt,
  type BackupSnapshotV4,
  type DegradationReason,
  type ProtectionState,
  type RestoreVerificationReceipt,
} from './schema.js';
import type { ProtectionHealth, ProtectionTarget } from '../domain/protection.js';
import type { RegionCode } from '../domain/region.js';

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
  recoveryRequired: boolean;
  currentFailure?: GenerationFailure;
};

export type BackupReadResult =
  | { kind: 'missing' }
  | {
      kind: 'value';
      value: BackupSnapshotV4;
      source: 'current' | 'previous';
      degraded: boolean;
      recoveryRequired: boolean;
      currentFailure?: GenerationFailure;
    };

export type RepositoryOptions = {
  root: string;
  filesystem?: DurableFileSystem;
  requiredBoundarySafety?: BoundarySafetyCapability;
  now?: () => string;
};

const mutationQueues = new Map<string, Promise<void>>();

function mutationKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLocaleLowerCase('en-US') : absolute;
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

  constructor(options: RepositoryOptions) {
    this.root = options.root;
    this.paths = statePaths(options.root);
    this.filesystem = options.filesystem ?? nodeDurableFileSystem;
    this.requiredBoundarySafety = options.requiredBoundarySafety;
    this.now = options.now ?? (() => new Date().toISOString());
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
      recoveryRequired: result.degraded,
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
    return withProcessMutationLock(mutationKey(this.paths.state), async () => {
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
    const detachedNext = cloneImmutable(next);
    return withProcessMutationLock(mutationKey(this.paths.state), async () => {
      const current = await this.readInternal();
      if ('kind' in current) throw new RepositoryError('STATE_MISSING', 'Protection state is missing');
      if (current.recoveryRequired) {
        throw new RepositoryError(
          'RECOVERY_REQUIRED',
          'Protection state was recovered from a predecessor and cannot be committed',
        );
      }
      if (current.value.revision !== expectedRevision) {
        throw new RepositoryError('REVISION_MISMATCH', 'Protection state revision does not match');
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
      recoveryRequired: result.degraded,
      ...(result.currentFailure === undefined ? {} : { currentFailure: result.currentFailure }),
    };
  }

  read(): Promise<BackupReadResult> {
    return this.readInternal();
  }

  async create(snapshot: BackupSnapshotV4): Promise<PersistenceResult<BackupSnapshotV4>> {
    const immutable = cloneImmutable(snapshot);
    if (!isBackupSnapshotV4(immutable)) {
      throw new RepositoryError('INVALID_BACKUP', 'Backup snapshot does not match schema v4');
    }
    return withProcessMutationLock(mutationKey(this.paths.backup), async () => {
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
    receipt: RestoreVerificationReceipt,
  ): Promise<DurableWriteResult> {
    const immutableReceipt = cloneImmutable(receipt);
    if (!isRestoreVerificationReceipt(immutableReceipt)) {
      throw new RepositoryError('RESTORE_PROOF_INVALID', 'Restore receipt is incomplete or invalid');
    }
    return withProcessMutationLock(mutationKey(this.paths.backup), async () => {
      const existing = await this.readInternal();
      if (existing.kind === 'missing') {
        throw new RepositoryError('BACKUP_MISSING', 'Immutable backup is missing');
      }
      if (existing.value.snapshotId !== immutableReceipt.snapshotId) {
        throw new RepositoryError('RESTORE_PROOF_INVALID', 'Restore receipt snapshot does not match');
      }
      if (Date.parse(immutableReceipt.verifiedAt) < Date.parse(existing.value.createdAt)) {
        throw new RepositoryError('RESTORE_PROOF_INVALID', 'Restore receipt predates the snapshot');
      }
      try {
        // Establish two identical valid generations before deletion so any injected unlink fault
        // leaves at least one checked recovery generation.
        const preparation = await writeCheckedFile({
          stateRoot: this.root,
          filePath: this.paths.backup,
          schema: BACKUP_SCHEMA,
          filesystem: this.filesystem,
          requiredBoundarySafety: this.requiredBoundarySafety,
          payload: asJson(existing.value),
          validatePayload: validateBackupPayload,
        });
        const deletion = await deleteCheckedFile({
          stateRoot: this.root,
          filePath: this.paths.backup,
          schema: BACKUP_SCHEMA,
          filesystem: this.filesystem,
          requiredBoundarySafety: this.requiredBoundarySafety,
          validatePayload: validateBackupPayload,
        });
        return {
          boundarySafety: deletion.boundarySafety,
          directoryDurability:
            preparation.directoryDurability === 'unsupported' ||
            deletion.directoryDurability === 'unsupported'
              ? 'unsupported'
              : 'durable',
        };
      } catch (error) {
        throw new RepositoryError('DELETE_FAILED', 'Verified backup deletion failed', { cause: error });
      }
    });
  }
}
