import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { canonicalJson, type JsonValue } from './checksum.js';
import {
  nodeDurableFileSystem,
  readCheckedFile,
  validateDurablePathBoundary,
  writeCheckedFile,
  type BoundarySafetyCapability,
  type DurableFileSystem,
} from './durable-file.js';
import {
  isMutationCoordinatorCapability,
  RepositoryError,
  StateRepository,
  mutationRootGateKey,
  runWithHeldMutationRoot,
  type MutationCoordinatorCapability,
} from './repository.js';
import { statePaths } from './paths.js';
import {
  BACKUP_AUTHORITY_IDS,
  BROWSER_POLICY_SLOTS,
  isBackupSnapshotV4,
  isProtectionState,
  storedMissing,
  storedValue,
  type BackupSnapshotV4,
  type BrowserPolicyBackup,
  type BrowserPolicySlotId,
  type DegradationReason,
  type ProtectionState,
} from './schema.js';
import { isRegionCode, type RegionCode } from '../domain/region.js';
import type { ProtectionHealth, ProtectionTarget } from '../domain/protection.js';

const LEGACY_KEYS = [
  'timestamp', 'schemaVersion', 'activeRegion', 'previous', 'previousSystemTimezone',
  'previousBrowserPolicies', 'previousLocaleName', 'previousUserLanguages', 'previousUserCulture',
] as const;

const LEGACY_POLICY_TO_V4: Readonly<Record<string, BrowserPolicySlotId>> = Object.freeze({
  'chrome/AcceptLanguage': 'chrome.accept_language',
  'chrome/DefaultWebRtcIPHandlingPolicy': 'chrome.webrtc',
  'chrome/ApplicationLocaleValue': 'chrome.application_locale',
  'edge/AcceptLanguage': 'edge.accept_language',
  'edge/DefaultWebRtcIPHandlingPolicy': 'edge.webrtc',
  'edge/ApplicationLocaleValue': 'edge.application_locale',
});

export type LegacyMigrationReason =
  | 'already_initialized'
  | 'daily_initialized_default'
  | 'daily_initialized_preferred'
  | 'invalid_preferred_region'
  | 'legacy_v3_migrated'
  | 'legacy_daily_facts_incomplete'
  | 'legacy_target_ambiguous'
  | 'legacy_target_mismatch'
  | 'legacy_classifier_invalid'
  | 'legacy_corrupt_json'
  | 'legacy_unknown_schema'
  | 'legacy_invalid_shape'
  | 'evidence_preservation_failed'
  | 'backup_conversion_failed'
  | 'state_commit_failed'
  | 'legacy_restore_failed'
  | 'state_read_failed'
  | 'lock_required'
  | 'lock_failed'
  | 'lock_release_failed'
  | 'snapshot_id_failed';

export class LegacyMigrationError extends Error {
  constructor(readonly code: Extract<LegacyMigrationReason,
    'legacy_corrupt_json' | 'legacy_unknown_schema' | 'legacy_invalid_shape'>, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LegacyMigrationError';
  }
}

export type ParsedLegacyBackup =
  | {
      kind: 'complete';
      activeRegion?: RegionCode;
      activeRegionStatus: 'legal' | 'missing' | 'invalid';
      backup: BackupSnapshotV4;
    }
  | {
      kind: 'incomplete';
      reason: 'legacy_daily_facts_incomplete';
      activeRegion?: RegionCode;
      activeRegionStatus: 'legal' | 'missing' | 'invalid';
      missingFacts: string[];
    };

export type LegacyProtectionObservation = Readonly<{
  candidates: readonly unknown[];
  health?: unknown;
  degradation?: readonly unknown[];
}>;

/** Read-only by contract. T08 supplies the Windows authority implementation. */
export interface LegacyProtectionClassifier {
  classify(): Promise<LegacyProtectionObservation>;
}

export type EvidencePreservation = Readonly<{
  path: string;
  hash: string;
  directoryDurability: 'durable' | 'unsupported';
  readOnly: true;
  /** Node's path checks are identity-checked but not atomic no-follow operations. */
  boundarySafety: 'identity_checked_non_atomic' | 'native_no_follow';
}>;

export interface LegacyEvidenceStore {
  preserve(root: string, bytes: Buffer, hash: string): Promise<EvidencePreservation>;
}

export interface LegacyEvidenceWriteHandle {
  write(bytes: Buffer): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface LegacyEvidenceFileBackend {
  ensureDirectory(path: string): Promise<void>;
  createExclusive(path: string): Promise<LegacyEvidenceWriteHandle>;
  readBytes(path: string): Promise<Buffer>;
  setReadOnly(path: string): Promise<void>;
  queryReadOnly(path: string): Promise<boolean>;
  syncDirectory(path: string): Promise<'durable' | 'unsupported'>;
}

export interface LegacyBackupConversionStore {
  readBytes(): Promise<Buffer | undefined>;
  /** Migration-only exact compare-and-replace. Implementations must preserve expected bytes on failure. */
  replaceLegacy(expected: Buffer, snapshot: BackupSnapshotV4): Promise<void>;
  /** Restores the exact v3 bytes if the final state commit cannot be published. */
  restoreLegacy(expected: Buffer): Promise<void>;
}

export interface MigrationStateStore {
  read(): Promise<ProtectionState | undefined>;
  /** One atomic initialization; callers may not publish an intermediate daily state. */
  initialize(state: ProtectionState): Promise<void>;
}

export class RepositoryMigrationStateStore implements MigrationStateStore {
  constructor(private readonly repository: StateRepository) {}

  async read(): Promise<ProtectionState | undefined> {
    try {
      return (await this.repository.read()).value;
    } catch (error) {
      if (error instanceof RepositoryError && error.code === 'STATE_MISSING') return undefined;
      throw error;
    }
  }

  async initialize(state: ProtectionState): Promise<void> {
    await this.repository.initializeImported(state);
  }
}

export type MigrationResult = Readonly<{
  kind: 'migrated' | 'recovery_required' | 'noop' | 'failed';
  reason: LegacyMigrationReason;
  evidencePath?: string;
  evidenceHash?: string;
  evidenceDirectoryDurability?: 'durable' | 'unsupported';
  committedTarget: ProtectionTarget | null;
  stateWritten: boolean;
  retryable?: boolean;
}>;

export type LegacyMigrationOptions = Readonly<{
  root: string;
  coordinator: MutationCoordinatorCapability;
  stateStore: MigrationStateStore;
  backupStore: LegacyBackupConversionStore;
  evidenceStore: LegacyEvidenceStore;
  classifier: LegacyProtectionClassifier;
  preferredRegion?: unknown;
  now?: () => string;
  snapshotId?: () => string;
}>;

function ownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function activeRegion(value: unknown): { value?: RegionCode; status: 'legal' | 'missing' | 'invalid' } {
  if (value === undefined) return { status: 'missing' };
  return isRegionCode(value) ? { value, status: 'legal' } : { status: 'invalid' };
}

function environmentValue(value: unknown) {
  return value === null ? storedMissing<string | null>() : storedValue(value as string);
}

function policyValue(value: unknown) {
  return value === null
    ? storedMissing<import('./schema.js').RegistryValue>()
    : storedValue({ registryType: 'REG_SZ' as const, value: value as string });
}

export function parseLegacyBackupV3(bytes: Buffer): ParsedLegacyBackup {
  if (!Buffer.isBuffer(bytes)) {
    throw new LegacyMigrationError('legacy_invalid_shape', 'Legacy migration parser accepts bytes only');
  }
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
    throw new LegacyMigrationError('legacy_corrupt_json', 'Legacy backup is not canonical UTF-8 bytes');
  }
  let input: unknown;
  try {
    input = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new LegacyMigrationError('legacy_corrupt_json', 'Legacy backup is not valid JSON', { cause: error });
  }
  if (!ownRecord(input)) throw new LegacyMigrationError('legacy_invalid_shape', 'Legacy backup must be an object');
  if (!exactKeys(input, LEGACY_KEYS)) throw new LegacyMigrationError('legacy_invalid_shape', 'Legacy backup has unknown fields');
  if (input.schemaVersion !== undefined) {
    if (!Number.isSafeInteger(input.schemaVersion) || (input.schemaVersion as number) < 1) {
      throw new LegacyMigrationError('legacy_invalid_shape', 'Legacy schemaVersion is invalid');
    }
    if ((input.schemaVersion as number) > 3) {
      throw new LegacyMigrationError('legacy_unknown_schema', 'A newer backup schema cannot be migrated');
    }
  }
  if (!validTime(input.timestamp)) throw new LegacyMigrationError('legacy_invalid_shape', 'Legacy timestamp is invalid');
  const region = activeRegion(input.activeRegion);
  const missingFacts: string[] = [];

  if (!ownRecord(input.previous) || !exactKeys(input.previous, ['TZ', 'LANG', 'LC_ALL'])) {
    throw new LegacyMigrationError('legacy_invalid_shape', 'Legacy environment snapshot is invalid');
  }
  const environment: Record<'TZ' | 'LANG' | 'LC_ALL', ReturnType<typeof environmentValue>> = {} as never;
  for (const key of ['TZ', 'LANG', 'LC_ALL'] as const) {
    if (!(key in input.previous)) missingFacts.push(`previous.${key}`);
    else if (!(typeof input.previous[key] === 'string' || input.previous[key] === null)) {
      throw new LegacyMigrationError('legacy_invalid_shape', `Legacy previous.${key} has an invalid type`);
    } else environment[key] = environmentValue(input.previous[key]);
  }

  if (typeof input.previousSystemTimezone !== 'string' || input.previousSystemTimezone.length === 0) {
    missingFacts.push('previousSystemTimezone');
  }

  const browserPolicies: Partial<Record<BrowserPolicySlotId, BrowserPolicyBackup>> = {};
  if (input.previousBrowserPolicies === undefined) {
    missingFacts.push('previousBrowserPolicies');
  } else if (!ownRecord(input.previousBrowserPolicies) ||
    !exactKeys(input.previousBrowserPolicies, Object.keys(LEGACY_POLICY_TO_V4))) {
    throw new LegacyMigrationError('legacy_invalid_shape', 'Legacy browser policy snapshot is invalid');
  } else {
    for (const [legacyKey, slotId] of Object.entries(LEGACY_POLICY_TO_V4)) {
      if (!(legacyKey in input.previousBrowserPolicies)) {
        missingFacts.push(`previousBrowserPolicies.${legacyKey}`);
        continue;
      }
      const value = input.previousBrowserPolicies[legacyKey];
      if (!(typeof value === 'string' || value === null)) {
        throw new LegacyMigrationError('legacy_invalid_shape', `Legacy browser policy ${legacyKey} has an invalid type`);
      }
      const slot = BROWSER_POLICY_SLOTS.find((candidate) => candidate.id === slotId)!;
      browserPolicies[slotId] = { keyPath: slot.keyPath, valueName: slot.valueName, value: policyValue(value) };
    }
  }

  if (typeof input.previousLocaleName !== 'string') missingFacts.push('previousLocaleName');
  if (!Array.isArray(input.previousUserLanguages) ||
    !input.previousUserLanguages.every((value) => typeof value === 'string')) {
    missingFacts.push('previousUserLanguages');
  }
  if (typeof input.previousUserCulture !== 'string') missingFacts.push('previousUserCulture');

  if (missingFacts.length > 0) {
    return {
      kind: 'incomplete', reason: 'legacy_daily_facts_incomplete',
      ...(region.value === undefined ? {} : { activeRegion: region.value }),
      activeRegionStatus: region.status, missingFacts,
    };
  }

  const backup: BackupSnapshotV4 = {
    schemaVersion: 4,
    snapshotId: '00000000-0000-4000-8000-000000000000',
    createdAt: input.timestamp,
    complete: true,
    authoritySet: [...BACKUP_AUTHORITY_IDS],
    authorities: {
      environment,
      systemTimezone: storedValue(input.previousSystemTimezone as string),
      browserPolicies: browserPolicies as Record<BrowserPolicySlotId, BrowserPolicyBackup>,
      localeName: storedValue(input.previousLocaleName as string),
      userLanguageList: storedValue(input.previousUserLanguages as string[]),
      culture: storedValue(input.previousUserCulture as string),
    },
  };
  if (!isBackupSnapshotV4(backup)) {
    throw new LegacyMigrationError('legacy_invalid_shape', 'Legacy backup cannot form a valid v4 snapshot');
  }
  return {
    kind: 'complete', ...(region.value === undefined ? {} : { activeRegion: region.value }),
    activeRegionStatus: region.status, backup,
  };
}

function isTarget(value: unknown): value is ProtectionTarget {
  return ownRecord(value) && exactKeys(value, ['mode', 'region']) &&
    (value.mode === 'standard' || value.mode === 'deep') && isRegionCode(value.region);
}

function normalizeObservation(observation: LegacyProtectionObservation): {
  targets: ProtectionTarget[]; health: ProtectionHealth; degradation: DegradationReason[];
} | undefined {
  if (!ownRecord(observation) || !exactKeys(observation, ['candidates', 'health', 'degradation']) ||
    !Array.isArray(observation.candidates) || !observation.candidates.every(isTarget)) return undefined;
  const targets = [...new Map(observation.candidates.map((target) => [`${target.mode}:${target.region}`, target])).values()];
  const health = observation.health ?? 'healthy';
  const degradation = observation.degradation ?? [];
  if (!(health === 'healthy' || health === 'degraded') || !Array.isArray(degradation)) return undefined;
  const probe: ProtectionState = {
    schemaVersion: 1, revision: 0, committedTarget: targets[0] ?? null, preferredRegion: targets[0]?.region ?? 'us',
    health, degradation: degradation as DegradationReason[], activeTransactionId: null, updatedAt: '2026-01-01T00:00:00.000Z',
  };
  if (!isProtectionState(probe)) return undefined;
  return { targets, health, degradation: structuredClone(degradation) as DegradationReason[] };
}

function result(
  kind: MigrationResult['kind'], reason: LegacyMigrationReason, committedTarget: ProtectionTarget | null,
  stateWritten: boolean, evidence?: EvidencePreservation,
): MigrationResult {
  return Object.freeze({
    kind, reason, committedTarget, stateWritten,
    ...(evidence === undefined ? {} : {
      evidencePath: evidence.path, evidenceHash: evidence.hash,
      evidenceDirectoryDurability: evidence.directoryDurability,
    }),
  });
}

function initialState(
  preferredRegion: RegionCode, committedTarget: ProtectionTarget | null,
  health: ProtectionHealth, degradation: DegradationReason[], now: () => string,
): ProtectionState {
  return {
    schemaVersion: 1, revision: 0, committedTarget, preferredRegion, health,
    degradation, activeTransactionId: null, updatedAt: now(),
  };
}

async function runMigration(options: LegacyMigrationOptions): Promise<MigrationResult> {
  let existing: ProtectionState | undefined;
  try {
    existing = await options.stateStore.read();
  } catch {
    return result('failed', 'state_read_failed', null, false);
  }
  if (existing !== undefined) return result('noop', 'already_initialized', existing.committedTarget, false);

  let bytes: Buffer | undefined;
  try {
    bytes = await options.backupStore.readBytes();
  } catch {
    return result('failed', 'backup_conversion_failed', null, false);
  }
  const now = options.now ?? (() => new Date().toISOString());
  if (bytes === undefined) {
    if (options.preferredRegion !== undefined && !isRegionCode(options.preferredRegion)) {
      return result('failed', 'invalid_preferred_region', null, false);
    }
    const preferred = options.preferredRegion ?? 'us';
    try {
      await options.stateStore.initialize(initialState(preferred, null, 'healthy', [], now));
      return result('migrated', options.preferredRegion === undefined ? 'daily_initialized_default' : 'daily_initialized_preferred', null, true);
    } catch {
      return result('failed', 'state_commit_failed', null, false);
    }
  }

  const hash = createHash('sha256').update(bytes).digest('hex');
  let evidence: EvidencePreservation;
  try {
    evidence = await options.evidenceStore.preserve(options.root, bytes, hash);
    if (evidence.hash !== hash || evidence.readOnly !== true) throw new Error('Evidence verification contract failed');
  } catch {
    return result('failed', 'evidence_preservation_failed', null, false);
  }

  let parsed: ParsedLegacyBackup;
  try {
    parsed = parseLegacyBackupV3(bytes);
  } catch (error) {
    return result('failed', error instanceof LegacyMigrationError ? error.code : 'legacy_invalid_shape', null, false, evidence);
  }
  if (parsed.kind === 'incomplete') {
    return result('recovery_required', parsed.reason, null, false, evidence);
  }

  let observation;
  try {
    observation = normalizeObservation(await options.classifier.classify());
  } catch {
    observation = undefined;
  }
  if (observation === undefined) return result('failed', 'legacy_classifier_invalid', null, false, evidence);
  if (observation.targets.length !== 1) {
    return result('recovery_required', 'legacy_target_ambiguous', null, false, evidence);
  }
  const target = observation.targets[0]!;
  if (parsed.activeRegionStatus === 'legal' && parsed.activeRegion !== target.region) {
    return result('recovery_required', 'legacy_target_mismatch', null, false, evidence);
  }

  let snapshotId: string;
  try {
    snapshotId = (options.snapshotId ?? randomUUID)();
  } catch {
    return result('failed', 'snapshot_id_failed', null, false, evidence);
  }
  const snapshot = { ...parsed.backup, snapshotId };
  if (!isBackupSnapshotV4(snapshot)) return result('failed', 'legacy_invalid_shape', null, false, evidence);
  try {
    await options.backupStore.replaceLegacy(bytes, snapshot);
  } catch {
    return result('failed', 'backup_conversion_failed', null, false, evidence);
  }
  try {
    await options.stateStore.initialize(initialState(target.region, target, observation.health, observation.degradation, now));
  } catch {
    try {
      await options.backupStore.restoreLegacy(bytes);
    } catch {
      return result('recovery_required', 'legacy_restore_failed', target, false, evidence);
    }
    return Object.freeze({ ...result('recovery_required', 'state_commit_failed', target, false, evidence), retryable: true });
  }
  return result('migrated', 'legacy_v3_migrated', target, true, evidence);
}

export async function migrateLegacyProtection(options: LegacyMigrationOptions): Promise<MigrationResult> {
  if (!isAbsolute(options.root) || !isMutationCoordinatorCapability(options.coordinator)) {
    return result('failed', 'lock_required', null, false);
  }
  let lock;
  try {
    lock = await options.coordinator.acquire({
      lockKey: mutationRootGateKey(options.root), stateRoot: options.root,
      filePath: options.root, operation: 'migration.run',
    });
  } catch {
    return result('failed', 'lock_failed', null, false);
  }
  let migrationResult: MigrationResult;
  let releaseFailed = false;
  try {
    migrationResult = await runWithHeldMutationRoot(options.root, () => runMigration(options));
  } finally {
    try {
      await lock.release();
    } catch {
      releaseFailed = true;
    }
  }
  if (releaseFailed) {
    return result(
      migrationResult.stateWritten ? 'recovery_required' : 'failed',
      'lock_release_failed', migrationResult.committedTarget, migrationResult.stateWritten,
      migrationResult.evidencePath === undefined ? undefined : {
        path: migrationResult.evidencePath,
        hash: migrationResult.evidenceHash!,
        directoryDurability: migrationResult.evidenceDirectoryDurability!,
        readOnly: true,
        boundarySafety: 'identity_checked_non_atomic',
      },
    );
  }
  return migrationResult;
}

export type NodeLegacyBackupConversionOptions = Readonly<{
  root: string;
  filesystem?: DurableFileSystem;
  requiredBoundarySafety?: BoundarySafetyCapability;
}>;

/** Fixed-path migration adapter. The enclosing migration coordinator is the authorization boundary. */
export class NodeLegacyBackupConversionStore implements LegacyBackupConversionStore {
  private readonly path: string;
  private readonly filesystem: DurableFileSystem;
  private readonly requiredBoundarySafety: BoundarySafetyCapability | undefined;

  constructor(private readonly options: NodeLegacyBackupConversionOptions) {
    this.path = statePaths(options.root).backup;
    this.filesystem = options.filesystem ?? nodeDurableFileSystem;
    this.requiredBoundarySafety = options.requiredBoundarySafety;
  }

  async readBytes(): Promise<Buffer | undefined> {
    await this.validateBoundary();
    try {
      const bytes = Buffer.from(await this.filesystem.readFile(this.path), 'utf8');
      await this.validateBoundary();
      return bytes;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async replaceLegacy(expected: Buffer, snapshot: BackupSnapshotV4): Promise<void> {
    if (!isBackupSnapshotV4(snapshot)) throw new Error('Invalid v4 migration snapshot');
    const before = await this.readBytes();
    if (before === undefined || !before.equals(expected)) throw new Error('Legacy backup changed before conversion');
    try {
      await writeCheckedFile({
        stateRoot: this.options.root,
        filePath: this.path,
        schema: 'cc-fix-backup-v4',
        filesystem: this.filesystem,
        requiredBoundarySafety: this.requiredBoundarySafety,
        payload: snapshot as unknown as JsonValue,
        validatePayload: (payload) => isBackupSnapshotV4(payload),
      });
    } catch (error) {
      const after = await this.readBytes().catch(() => undefined);
      if (after?.equals(expected)) throw error;
      const converted = await this.readConverted(snapshot).catch(() => false);
      if (converted) return;
      await this.restoreLegacy(expected).catch(() => undefined);
      throw new Error('Legacy conversion failed after an uncertain replacement; verified evidence is retained', { cause: error });
    }
    if (!(await this.readConverted(snapshot))) throw new Error('Converted v4 backup failed readback verification');
  }

  async restoreLegacy(expected: Buffer): Promise<void> {
    const text = expected.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(expected)) throw new Error('Legacy bytes are not lossless UTF-8');
    await this.validateBoundary();
    const temporary = `${this.path}.migration-restore-${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await this.filesystem.open(temporary, 'wx');
      await handle.writeFile(text);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.filesystem.replace(temporary, this.path);
      await this.validateBoundary();
      const restored = await this.readBytes();
      if (restored === undefined || !restored.equals(expected)) throw new Error('Legacy byte restoration verification failed');
      let directory;
      try {
        directory = await this.filesystem.openDirectory(this.options.root);
        await directory.sync();
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (!(this.filesystem.directorySyncCapability === 'unsupported' || code === 'EINVAL' || code === 'EPERM')) throw error;
      } finally {
        await directory?.close().catch(() => undefined);
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await this.filesystem.unlink(temporary).catch(() => undefined);
    }
  }

  private async readConverted(expected: BackupSnapshotV4): Promise<boolean> {
    const read = await readCheckedFile({
      stateRoot: this.options.root,
      filePath: this.path,
      schema: 'cc-fix-backup-v4',
      filesystem: this.filesystem,
      requiredBoundarySafety: this.requiredBoundarySafety,
      validatePayload: (payload) => isBackupSnapshotV4(payload),
    });
    return read.kind === 'ok' &&
      canonicalJson(read.payload) === canonicalJson(expected as unknown as JsonValue);
  }

  private async validateBoundary(): Promise<void> {
    await validateDurablePathBoundary(
      this.options.root,
      this.path,
      this.filesystem,
      this.requiredBoundarySafety,
    );
  }
}

const nodeLegacyEvidenceBackend: LegacyEvidenceFileBackend = {
  ensureDirectory: (path) => mkdir(path, { recursive: true }).then(() => undefined),
  createExclusive: async (path) => {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    return {
      write: (bytes) => handle.writeFile(bytes).then(() => undefined),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  readBytes: (path) => readFile(path),
  setReadOnly: (path) => chmod(path, 0o444),
  queryReadOnly: async (path) => (await stat(path)).mode & 0o222 ? false : true,
  syncDirectory: async (path) => {
    let handle;
    try {
      handle = await open(path, 'r');
      await handle.sync();
      return 'durable';
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code === 'EINVAL' || code === 'EPERM') return 'unsupported';
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
};

export class NodeLegacyEvidenceStore implements LegacyEvidenceStore {
  constructor(
    private readonly backend: LegacyEvidenceFileBackend = nodeLegacyEvidenceBackend,
    private readonly filesystem: DurableFileSystem = nodeDurableFileSystem,
    private readonly requiredBoundarySafety?: BoundarySafetyCapability,
  ) {}

  async preserve(root: string, bytes: Buffer, hash: string): Promise<EvidencePreservation> {
    if (!isAbsolute(root) || !/^[0-9a-f]{64}$/u.test(hash) || createHash('sha256').update(bytes).digest('hex') !== hash) {
      throw new Error('Invalid migration evidence request');
    }
    const directory = join(root, 'migration-evidence');
    const path = join(directory, `legacy-v3-sha256-${hash}.json`);
    // The root already exists at migration time; validate a direct child before
    // creating the evidence directory, then validate the actual file before and
    // after every raw-byte write/read sequence.
    await this.validateBoundary(root, join(root, '.legacy-migration-boundary-probe'));
    await this.backend.ensureDirectory(directory);
    await this.validateBoundary(root, path);
    let handle;
    try {
      handle = await this.backend.createExclusive(path);
      await handle.write(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code !== 'EEXIST') throw error;
      const existing = await this.backend.readBytes(path);
      if (!existing.equals(bytes)) throw new Error('Migration evidence hash-path collision contains different bytes');
    }
    const readback = await this.backend.readBytes(path);
    await this.validateBoundary(root, path);
    if (!readback.equals(bytes) || createHash('sha256').update(readback).digest('hex') !== hash) {
      throw new Error('Migration evidence readback verification failed');
    }
    await this.backend.setReadOnly(path);
    const afterReadonly = await this.backend.readBytes(path);
    await this.validateBoundary(root, path);
    if (!afterReadonly.equals(bytes) || !(await this.backend.queryReadOnly(path))) {
      throw new Error('Migration evidence read-only verification failed');
    }
    const directoryDurability = await this.backend.syncDirectory(directory);
    return Object.freeze({ path, hash, directoryDurability, readOnly: true, boundarySafety: 'identity_checked_non_atomic' });
  }

  private async validateBoundary(root: string, path: string): Promise<void> {
    // A custom backend is an isolated test or native implementation and owns
    // its own boundary contract. The default Node implementation must always
    // use the shared T04 guard before it touches the host filesystem.
    if (this.backend !== nodeLegacyEvidenceBackend) return;
    await validateDurablePathBoundary(root, path, this.filesystem, this.requiredBoundarySafety);
  }
}
