import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createJunctionWithRetry } from '../test-support/junction.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { InProcessTestMutationCoordinator } from './test-support/in-process-mutation-coordinator.js';
import {
  LegacyMigrationError,
  NodeLegacyBackupConversionStore,
  NodeLegacyEvidenceStore,
  RepositoryMigrationStateStore,
  migrateLegacyProtection,
  parseLegacyBackupV3,
  type LegacyBackupConversionStore,
  type LegacyEvidenceStore,
  type LegacyEvidenceFileBackend,
  type LegacyProtectionClassifier,
  type MigrationStateStore,
} from './migration.js';
import { completeLegacyV3, legacyBytes, LEGACY_BROWSER_SLOT_KEYS } from './fixtures/legacy-v3.js';
import type { BackupSnapshotV4, ProtectionState } from './schema.js';
import { BackupRepository, StateRepository } from './repository.js';
import { nodeDurableFileSystem, writeCheckedFile } from './durable-file.js';
import { statePaths } from './paths.js';
import { issueMutationCoordinatorCapability } from './internal/capabilities.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function classifier(...candidates: Array<{ mode: 'standard' | 'deep'; region: 'us' | 'eu' | 'jp' | 'sg' }>): LegacyProtectionClassifier {
  return { classify: async () => ({ candidates, health: 'healthy', degradation: [] }) };
}

class MemoryStateStore implements MigrationStateStore {
  state: ProtectionState | undefined;
  failWrite = false;
  writes = 0;
  async read(): Promise<ProtectionState | undefined> { return this.state; }
  async initialize(state: ProtectionState): Promise<void> {
    this.writes++;
    if (this.failWrite) {
      this.failWrite = false;
      throw new Error('state write failed');
    }
    if (this.state !== undefined) throw new Error('state exists');
    this.state = structuredClone(state);
  }
}

class MemoryBackupStore implements LegacyBackupConversionStore {
  bytes: Buffer | undefined;
  converted: BackupSnapshotV4 | undefined;
  failWrite = false;
  failRestore = false;
  writes = 0;
  constructor(bytes?: Buffer) { this.bytes = bytes; }
  async readBytes(): Promise<Buffer | undefined> { return this.bytes === undefined ? undefined : Buffer.from(this.bytes); }
  async replaceLegacy(expected: Buffer, snapshot: BackupSnapshotV4): Promise<void> {
    this.writes++;
    if (this.bytes === undefined || !this.bytes.equals(expected)) throw new Error('legacy changed');
    if (this.failWrite) throw new Error('v4 write failed');
    this.converted = structuredClone(snapshot);
    this.bytes = Buffer.from('checked-v4');
  }
  async restoreLegacy(expected: Buffer): Promise<void> {
    if (this.failRestore) throw new Error('legacy restore failed');
    this.converted = undefined;
    this.bytes = Buffer.from(expected);
  }
}

class MemoryEvidenceStore implements LegacyEvidenceStore {
  bytes: Buffer | undefined;
  fail = false;
  calls = 0;
  async preserve(_root: string, bytes: Buffer, hash: string) {
    this.calls++;
    if (this.fail) throw new Error('evidence failed');
    this.bytes = Buffer.from(bytes);
    return { path: `C:\\state\\migration-evidence\\legacy-v3-sha256-${hash}.json`, hash, directoryDurability: 'durable' as const, readOnly: true as const, boundarySafety: 'identity_checked_non_atomic' as const };
  }
}

function setup(bytes: Buffer | undefined = legacyBytes()) {
  const state = new MemoryStateStore();
  const backup = new MemoryBackupStore(bytes);
  const evidence = new MemoryEvidenceStore();
  const coordinator = new InProcessTestMutationCoordinator();
  return { state, backup, evidence, coordinator };
}

describe('strict legacy v3 parser', () => {
  it.each(['us', 'eu', 'jp', 'sg'] as const)('losslessly parses a complete %s fixture', (region) => {
    const parsed = parseLegacyBackupV3(legacyBytes(region));
    expect(parsed.kind).toBe('complete');
    if (parsed.kind !== 'complete') return;
    expect(parsed.activeRegion).toBe(region);
    expect(parsed.backup.authorities.environment).toEqual({
      TZ: { kind: 'missing' },
      LANG: { kind: 'value', value: '' },
      LC_ALL: { kind: 'value', value: 'daily-locale' },
    });
    expect(parsed.backup.authorities.userLanguageList).toEqual({ kind: 'value', value: [] });
    expect(Object.keys(parsed.backup.authorities.browserPolicies)).toHaveLength(6);
  });

  it.each([
    ['environment', (value: Record<string, unknown>) => { delete (value.previous as Record<string, unknown>).TZ; }],
    ['timezone', (value: Record<string, unknown>) => { delete value.previousSystemTimezone; }],
    ['locale', (value: Record<string, unknown>) => { value.previousLocaleName = null; }],
    ['languages', (value: Record<string, unknown>) => { value.previousUserLanguages = null; }],
    ['culture', (value: Record<string, unknown>) => { value.previousUserCulture = undefined; }],
    ['browser-slot', (value: Record<string, unknown>) => { delete (value.previousBrowserPolicies as Record<string, unknown>)['edge/ApplicationLocaleValue']; }],
  ])('classifies missing/ambiguous %s daily facts as incomplete', (_name, mutate) => {
    const value = completeLegacyV3();
    mutate(value);
    const parsed = parseLegacyBackupV3(Buffer.from(JSON.stringify(value)));
    expect(parsed).toMatchObject({ kind: 'incomplete' });
  });

  it('accepts null only where old code proved it meant an absent env/policy value', () => {
    const value = completeLegacyV3();
    value.previousSystemTimezone = null;
    expect(parseLegacyBackupV3(Buffer.from(JSON.stringify(value)))).toMatchObject({ kind: 'incomplete' });
    value.previousSystemTimezone = 'UTC';
    value.previousLocaleName = null;
    expect(parseLegacyBackupV3(Buffer.from(JSON.stringify(value)))).toMatchObject({ kind: 'incomplete' });
  });

  it('recognizes the historical four-slot browser snapshot but never fills its two missing slots', () => {
    const value = completeLegacyV3();
    const policies = value.previousBrowserPolicies as Record<string, unknown>;
    delete policies['chrome/ApplicationLocaleValue'];
    delete policies['edge/ApplicationLocaleValue'];
    expect(parseLegacyBackupV3(Buffer.from(JSON.stringify(value)))).toMatchObject({
      kind: 'incomplete', reason: 'legacy_daily_facts_incomplete',
    });
  });

  it.each([
    Buffer.from('{"schemaVersion":3'),
    Buffer.from(JSON.stringify({ ...completeLegacyV3(), schemaVersion: 4 })),
    Buffer.from(JSON.stringify({ ...completeLegacyV3(), surprise: true })),
    Buffer.from(JSON.stringify({ ...completeLegacyV3(), timestamp: 'not-a-time' })),
  ])('fails closed for corrupt, newer, extra, and invalid-time input', (bytes) => {
    expect(() => parseLegacyBackupV3(bytes)).toThrow(LegacyMigrationError);
  });

  it.each([
    Buffer.from([0xff, 0xfe, 0xfd]),
    Buffer.from('null'),
    Buffer.from(JSON.stringify({ ...completeLegacyV3(), schemaVersion: 0 })),
    Buffer.from(JSON.stringify({ ...completeLegacyV3(), schemaVersion: '3' })),
    Buffer.from(JSON.stringify({ ...completeLegacyV3(), previous: [] })),
    Buffer.from(JSON.stringify({ ...completeLegacyV3(), previous: { TZ: false, LANG: null, LC_ALL: null } })),
    Buffer.from(JSON.stringify({ ...completeLegacyV3(), previousBrowserPolicies: [] })),
    Buffer.from(JSON.stringify({
      ...completeLegacyV3(),
      previousBrowserPolicies: { ...(completeLegacyV3().previousBrowserPolicies as object), unknown: null },
    })),
    Buffer.from(JSON.stringify({
      ...completeLegacyV3(),
      previousBrowserPolicies: {
        ...(completeLegacyV3().previousBrowserPolicies as object),
        'chrome/AcceptLanguage': 42,
      },
    })),
    Buffer.from(JSON.stringify({ ...completeLegacyV3(), timestamp: '2026-02-31T00:00:00.000Z' })),
  ])('rejects unsafe legacy byte and field shapes without accessors or inference', (bytes) => {
    expect(() => parseLegacyBackupV3(bytes)).toThrow(LegacyMigrationError);
  });

  it('marks an illegal region without silently replacing it', () => {
    const parsed = parseLegacyBackupV3(Buffer.from(JSON.stringify({ ...completeLegacyV3(), activeRegion: 'cn' })));
    expect(parsed).toMatchObject({ activeRegionStatus: 'invalid' });
    expect(parsed.activeRegion).toBeUndefined();
  });

  it('rejects accessor-like and non-byte entry paths by exposing only a byte parser', () => {
    expect(() => parseLegacyBackupV3('not bytes' as never)).toThrowError(/bytes/i);
  });

  it('keeps the exact six historical slots including ApplicationLocaleValue', () => {
    expect(LEGACY_BROWSER_SLOT_KEYS).toEqual([
      'chrome/AcceptLanguage', 'chrome/DefaultWebRtcIPHandlingPolicy', 'chrome/ApplicationLocaleValue',
      'edge/AcceptLanguage', 'edge/DefaultWebRtcIPHandlingPolicy', 'edge/ApplicationLocaleValue',
    ]);
  });
});

describe('legacy migration transaction', () => {
  it('preserves evidence, converts backup, and commits state last for a unique target', async () => {
    const deps = setup();
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence, classifier: classifier({ mode: 'deep', region: 'us' }),
      now: () => '2026-01-02T03:04:06.000Z', snapshotId: () => '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(result).toMatchObject({ kind: 'migrated', reason: 'legacy_v3_migrated', stateWritten: true, committedTarget: { mode: 'deep', region: 'us' } });
    expect(sha256(deps.evidence.bytes!)).toBe(sha256(legacyBytes()));
    expect(deps.backup.converted?.schemaVersion).toBe(4);
    expect(deps.state.state?.committedTarget).toEqual({ mode: 'deep', region: 'us' });
    expect(deps.state.state?.preferredRegion).toBe('us');
  });

  it('uses an authoritative unique classifier region only when activeRegion is absent', async () => {
    const value = completeLegacyV3();
    delete value.activeRegion;
    const deps = setup(Buffer.from(JSON.stringify(value)));
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence, classifier: classifier({ mode: 'standard', region: 'jp' }),
    });
    expect(result).toMatchObject({ kind: 'migrated', committedTarget: { mode: 'standard', region: 'jp' } });
  });

  it('uses an authoritative unique classifier region when legacy activeRegion is illegal', async () => {
    const value = { ...completeLegacyV3(), activeRegion: 'cn' };
    const deps = setup(Buffer.from(JSON.stringify(value)));
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence, classifier: classifier({ mode: 'standard', region: 'sg' }),
    });
    expect(result).toMatchObject({ kind: 'migrated', committedTarget: { mode: 'standard', region: 'sg' } });
  });

  it.each([
    { candidates: [] as const },
    { candidates: [{ mode: 'standard', region: 'us' }, { mode: 'deep', region: 'us' }] as const },
  ])('leaves state missing and evidence intact for zero/multiple target ambiguity', async ({ candidates }) => {
    const value = completeLegacyV3();
    delete value.activeRegion;
    const deps = setup(Buffer.from(JSON.stringify(value)));
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence, classifier: classifier(...candidates),
    });
    expect(result).toMatchObject({ kind: 'recovery_required', reason: 'legacy_target_ambiguous', stateWritten: false });
    expect(deps.state.writes).toBe(0);
    expect(deps.backup.writes).toBe(0);
    expect(deps.evidence.bytes).toEqual(Buffer.from(JSON.stringify(value)));
  });

  it('rejects a unique classifier target that contradicts legal activeRegion', async () => {
    const deps = setup();
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence, classifier: classifier({ mode: 'deep', region: 'eu' }),
    });
    expect(result).toMatchObject({ kind: 'recovery_required', reason: 'legacy_target_mismatch', stateWritten: false });
  });

  it('never converts incomplete daily facts or infers them from protected current observations', async () => {
    const value = completeLegacyV3();
    value.previousUserCulture = null;
    const original = Buffer.from(JSON.stringify(value));
    const deps = setup(original);
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence, classifier: classifier({ mode: 'deep', region: 'us' }),
    });
    expect(result).toMatchObject({ kind: 'recovery_required', reason: 'legacy_daily_facts_incomplete', stateWritten: false });
    expect(deps.backup.bytes).toEqual(original);
    expect(deps.backup.writes).toBe(0);
  });

  it('initializes daily only when no backup exists, honoring legal preference and true initial default', async () => {
    for (const [preferred, expected] of [['sg', 'sg'], [undefined, 'us']] as const) {
      const deps = setup();
      deps.backup.bytes = undefined;
      const result = await migrateLegacyProtection({
        root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
        backupStore: deps.backup, evidenceStore: deps.evidence, classifier: classifier(), preferredRegion: preferred,
      });
      expect(result).toMatchObject({ kind: 'migrated', reason: preferred === undefined ? 'daily_initialized_default' : 'daily_initialized_preferred' });
      expect(deps.state.state?.preferredRegion).toBe(expected);
      expect(deps.state.state?.committedTarget).toBeNull();
      expect(deps.evidence.calls).toBe(0);
    }
  });

  it('fails instead of silently defaulting an invalid persisted preference', async () => {
    const deps = setup();
    deps.backup.bytes = undefined;
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence, classifier: classifier(), preferredRegion: 'cn',
    });
    expect(result).toMatchObject({ kind: 'failed', reason: 'invalid_preferred_region', stateWritten: false });
    expect(deps.state.writes).toBe(0);
  });

  it.each(['evidence', 'backup', 'state'] as const)('reports the %s failure boundary without premature state', async (boundary) => {
    const deps = setup();
    if (boundary === 'evidence') deps.evidence.fail = true;
    if (boundary === 'backup') deps.backup.failWrite = true;
    if (boundary === 'state') deps.state.failWrite = true;
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence, classifier: classifier({ mode: 'deep', region: 'us' }),
    });
    expect(result.kind).toBe(boundary === 'state' ? 'recovery_required' : 'failed');
    expect(result.stateWritten).toBe(false);
    if (boundary !== 'evidence') expect(deps.evidence.bytes).toEqual(legacyBytes());
    if (boundary !== 'state') expect(deps.state.writes).toBe(0);
  });

  it('restores v3 after a final state failure so a retry can converge', async () => {
    const deps = setup();
    deps.state.failWrite = true;
    const options = {
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence, classifier: classifier({ mode: 'deep' as const, region: 'us' as const }),
    };
    expect(await migrateLegacyProtection(options)).toMatchObject({ kind: 'recovery_required', reason: 'state_commit_failed' });
    expect(deps.backup.bytes).toEqual(legacyBytes());
    expect(await migrateLegacyProtection(options)).toMatchObject({ kind: 'migrated', reason: 'legacy_v3_migrated' });
    expect(deps.state.state?.committedTarget).toEqual({ mode: 'deep', region: 'us' });
  });

  it('reports recovery required when state failure cannot restore the original v3 bytes', async () => {
    const deps = setup();
    deps.state.failWrite = true;
    deps.backup.failRestore = true;
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence, classifier: classifier({ mode: 'deep', region: 'us' }),
    });
    expect(result).toMatchObject({
      kind: 'recovery_required', reason: 'legacy_restore_failed',
      committedTarget: { mode: 'deep', region: 'us' }, stateWritten: false,
    });
    expect(deps.evidence.bytes).toEqual(legacyBytes());
  });

  it('serializes concurrent retries under one root migration lock', async () => {
    const deps = setup();
    const options = {
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence, classifier: classifier({ mode: 'deep' as const, region: 'us' as const }),
    };
    const results = await Promise.all([migrateLegacyProtection(options), migrateLegacyProtection(options)]);
    expect(results.map((result) => result.kind).sort()).toEqual(['migrated', 'noop']);
    expect(deps.state.writes).toBe(1);
    expect(deps.backup.writes).toBe(1);
  });

  it('reports uncertain lock release after a committed migration', async () => {
    const deps = setup();
    const coordinator = issueMutationCoordinatorCapability({
      acquire: async () => ({ release: async () => { throw new Error('release failed'); } }),
    });
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator, stateStore: deps.state, backupStore: deps.backup,
      evidenceStore: deps.evidence, classifier: classifier({ mode: 'deep', region: 'us' }),
    });
    expect(result).toMatchObject({
      kind: 'recovery_required', reason: 'lock_release_failed', stateWritten: true,
      committedTarget: { mode: 'deep', region: 'us' },
    });
  });

  it('deduplicates identical authoritative candidates before deciding uniqueness', async () => {
    const deps = setup();
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence,
      classifier: classifier({ mode: 'deep', region: 'us' }, { mode: 'deep', region: 'us' }),
    });
    expect(result).toMatchObject({ kind: 'migrated', committedTarget: { mode: 'deep', region: 'us' } });
  });

  it.each([
    { classify: async () => { throw new Error('read failed'); } },
    { classify: async () => ({ candidates: 'not-an-array' }) },
    { classify: async () => ({ candidates: [{ mode: 'daily', region: 'us' }] }) },
    { classify: async () => ({ candidates: [{ mode: 'deep', region: 'cn' }] }) },
    { classify: async () => ({ candidates: [{ mode: 'deep', region: 'us', extra: true }] }) },
    { classify: async () => ({ candidates: [{ mode: 'deep', region: 'us' }], health: 'recovery_required' }) },
    { classify: async () => ({ candidates: [{ mode: 'deep', region: 'us' }], health: 'degraded', degradation: [] }) },
  ] as LegacyProtectionClassifier[])('fails closed on invalid or non-authoritative classifier output', async (invalidClassifier) => {
    const deps = setup();
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence, classifier: invalidClassifier,
    });
    expect(result).toMatchObject({ kind: 'failed', reason: 'legacy_classifier_invalid', stateWritten: false });
    expect(deps.backup.writes).toBe(0);
  });

  it('rejects invalid generated snapshot identity before replacing v3', async () => {
    const deps = setup();
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence,
      classifier: classifier({ mode: 'deep', region: 'us' }), snapshotId: () => 'not-a-uuid',
    });
    expect(result).toMatchObject({ kind: 'failed', reason: 'legacy_invalid_shape' });
    expect(deps.backup.writes).toBe(0);
  });

  it('contains snapshot-id provider errors without changing the legacy backup', async () => {
    const deps = setup();
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator: deps.coordinator.capability, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence,
      classifier: classifier({ mode: 'deep', region: 'us' }), snapshotId: () => { throw new Error('entropy failure'); },
    });
    expect(result).toMatchObject({ kind: 'failed', reason: 'snapshot_id_failed', stateWritten: false });
    expect(deps.backup.writes).toBe(0);
  });

  it('reports backup read, daily state commit, bad evidence contract, and lock acquisition failures', async () => {
    const readFailure = setup();
    readFailure.backup.readBytes = async () => { throw new Error('read failed'); };
    expect(await migrateLegacyProtection({
      root: 'C:\\state', coordinator: readFailure.coordinator.capability, stateStore: readFailure.state,
      backupStore: readFailure.backup, evidenceStore: readFailure.evidence, classifier: classifier(),
    })).toMatchObject({ kind: 'failed', reason: 'backup_conversion_failed' });

    const dailyFailure = setup();
    dailyFailure.backup.bytes = undefined;
    dailyFailure.state.failWrite = true;
    expect(await migrateLegacyProtection({
      root: 'C:\\state', coordinator: dailyFailure.coordinator.capability, stateStore: dailyFailure.state,
      backupStore: dailyFailure.backup, evidenceStore: dailyFailure.evidence, classifier: classifier(),
    })).toMatchObject({ kind: 'failed', reason: 'state_commit_failed' });

    const badEvidence = setup();
    badEvidence.evidence.preserve = async (_root, _bytes, hash) => ({
      path: 'C:\\state\\bad', hash: `${hash.slice(0, -1)}0`, directoryDurability: 'durable', readOnly: true, boundarySafety: 'identity_checked_non_atomic',
    });
    expect(await migrateLegacyProtection({
      root: 'C:\\state', coordinator: badEvidence.coordinator.capability, stateStore: badEvidence.state,
      backupStore: badEvidence.backup, evidenceStore: badEvidence.evidence, classifier: classifier(),
    })).toMatchObject({ kind: 'failed', reason: 'evidence_preservation_failed' });

    const lockFailure = issueMutationCoordinatorCapability({ acquire: async () => { throw new Error('busy'); } });
    const locked = setup();
    expect(await migrateLegacyProtection({
      root: 'C:\\state', coordinator: lockFailure, stateStore: locked.state,
      backupStore: locked.backup, evidenceStore: locked.evidence, classifier: classifier(),
    })).toMatchObject({ kind: 'failed', reason: 'lock_failed' });
  });
});

describe('native migration evidence', () => {
  it('creates an exclusive, hash-named, read-only byte-identical copy idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-migration-'));
    const bytes = legacyBytes('eu');
    const hash = sha256(bytes);
    const store = new NodeLegacyEvidenceStore();
    const first = await store.preserve(root, bytes, hash);
    const second = await store.preserve(root, bytes, hash);
    expect(first.path).toBe(second.path);
    expect(await readFile(first.path)).toEqual(bytes);
    expect(first.path).toContain(hash);
    expect((await stat(first.path)).mode & 0o222).toBe(0);
  });

  it('fails closed if an existing same-hash path contains different bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-migration-'));
    const bytes = legacyBytes();
    const hash = sha256(bytes);
    const directory = join(root, 'migration-evidence');
    const store = new NodeLegacyEvidenceStore();
    const result = await store.preserve(root, bytes, hash);
    await chmod(result.path, 0o600);
    await writeFile(result.path, 'tampered', { mode: 0o600 });
    await expect(store.preserve(root, bytes, hash)).rejects.toThrow(/collision|different/i);
    expect(directory).toBe(join(root, 'migration-evidence'));
  });

  it('refuses a migration-evidence junction that escapes the supplied state root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-migration-'));
    const outside = await mkdtemp(join(tmpdir(), 'cc-fix-migration-outside-'));
    await createJunctionWithRetry(outside, join(root, 'migration-evidence'));
    const bytes = legacyBytes();
    await expect(new NodeLegacyEvidenceStore().preserve(root, bytes, sha256(bytes))).rejects.toMatchObject({
      code: 'REPARSE_BOUNDARY',
    });
  });

  it.each(['create', 'write', 'sync', 'readback', 'readonly', 'directory'] as const)(
    'fails closed on injected evidence %s failure', async (stage) => {
      let stored: Buffer | undefined;
      let reads = 0;
      const fail = (): never => { throw new Error(`injected ${stage} failure`); };
      const backend: LegacyEvidenceFileBackend = {
        ensureDirectory: async () => undefined,
        createExclusive: async () => {
          if (stage === 'create') fail();
          return {
            write: async (bytes) => { if (stage === 'write') fail(); stored = Buffer.from(bytes); },
            sync: async () => { if (stage === 'sync') fail(); },
            close: async () => undefined,
          };
        },
        readBytes: async () => {
          reads++;
          if (stored === undefined) fail();
          if (stage === 'readback' && reads === 1) return Buffer.from('corrupt');
          return Buffer.from(stored);
        },
        setReadOnly: async () => { if (stage === 'readonly') fail(); },
        queryReadOnly: async () => { if (stage === 'readonly') return false; return true; },
        syncDirectory: async () => { if (stage === 'directory') fail(); return 'durable'; },
      };
      const bytes = legacyBytes();
      await expect(new NodeLegacyEvidenceStore(backend).preserve('C:\\state', bytes, sha256(bytes)))
        .rejects.toThrow(/failure|verification/i);
    },
  );

  it('fails closed when setReadOnly succeeds but verification cannot prove the attribute', async () => {
    let stored: Buffer | undefined;
    const backend: LegacyEvidenceFileBackend = {
      ensureDirectory: async () => undefined,
      createExclusive: async () => ({ write: async (bytes) => { stored = Buffer.from(bytes); }, sync: async () => undefined, close: async () => undefined }),
      readBytes: async () => Buffer.from(stored!),
      setReadOnly: async () => undefined,
      queryReadOnly: async () => false,
      syncDirectory: async () => 'durable',
    };
    await expect(new NodeLegacyEvidenceStore(backend).preserve('C:\\state', legacyBytes(), sha256(legacyBytes())))
      .rejects.toThrow(/read-only verification/i);
  });
});

describe('native legacy backup conversion boundary', () => {
  it('refuses a legacy backup symlink that escapes the supplied state root', async () => {
    const actualRoot = await mkdtemp(join(tmpdir(), 'cc-fix-migration-'));
    const linkedRoot = join(tmpdir(), `cc-fix-migration-root-link-${Date.now()}-${Math.random()}`);
    await writeFile(statePaths(actualRoot).backup, legacyBytes());
    await createJunctionWithRetry(actualRoot, linkedRoot);
    await expect(new NodeLegacyBackupConversionStore({ root: linkedRoot }).readBytes()).rejects.toMatchObject({
      code: 'REPARSE_BOUNDARY',
    });
  });
});

describe('native checked-file migration adapters', () => {
  it('serializes concurrent repository initialization and backup creation behind the migration root gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-migration-adapter-'));
    const bytes = legacyBytes('jp');
    await writeFile(statePaths(root).backup, bytes);
    const coordinator = new InProcessTestMutationCoordinator();
    const stateRepository = new StateRepository({ root, mutationCoordinator: coordinator.capability });
    const backupRepository = new BackupRepository({ root, mutationCoordinator: coordinator.capability });
    let releaseClassifier!: () => void;
    const classifierStarted = new Promise<void>((resolve) => { releaseClassifier = resolve; });
    let enteredClassifier!: () => void;
    const entered = new Promise<void>((resolve) => { enteredClassifier = resolve; });
    const migration = migrateLegacyProtection({
      root, coordinator: coordinator.capability,
      stateStore: new RepositoryMigrationStateStore(stateRepository),
      backupStore: new NodeLegacyBackupConversionStore({ root }), evidenceStore: new NodeLegacyEvidenceStore(),
      classifier: { classify: async () => { enteredClassifier(); await classifierStarted; return { candidates: [{ mode: 'standard', region: 'jp' }] }; } },
      snapshotId: () => '123e4567-e89b-42d3-a456-426614174000',
    });
    await entered;
    const competingState = stateRepository.initialize('us');
    const parsed = parseLegacyBackupV3(bytes);
    expect(parsed.kind).toBe('complete');
    if (parsed.kind !== 'complete') throw new Error('fixture must be complete');
    const competingBackup = backupRepository.create({
      ...parsed.backup, snapshotId: '223e4567-e89b-42d3-a456-426614174000',
    });
    releaseClassifier();
    await expect(migration).resolves.toMatchObject({ kind: 'migrated' });
    await expect(competingState).rejects.toMatchObject({ code: 'STATE_ALREADY_EXISTS' });
    await expect(competingBackup).rejects.toMatchObject({ code: 'BACKUP_ALREADY_EXISTS' });
    expect((await stateRepository.read()).value.committedTarget).toEqual({ mode: 'standard', region: 'jp' });
    expect(await backupRepository.read()).toMatchObject({ kind: 'value', value: { snapshotId: '123e4567-e89b-42d3-a456-426614174000' } });
    expect(coordinator.requests[0]!.operation).toBe('migration.run');
    expect(coordinator.requests[0]!.lockKey).toContain('mutation-root');
  });

  it('migrates a real legacy file through T04 checked v4 and repository state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-migration-adapter-'));
    const bytes = legacyBytes('jp');
    await writeFile(statePaths(root).backup, bytes);
    const coordinator = new InProcessTestMutationCoordinator();
    const stateRepository = new StateRepository({ root, mutationCoordinator: coordinator.capability });
    const result = await migrateLegacyProtection({
      root,
      coordinator: coordinator.capability,
      stateStore: new RepositoryMigrationStateStore(stateRepository),
      backupStore: new NodeLegacyBackupConversionStore({ root }),
      evidenceStore: new NodeLegacyEvidenceStore(),
      classifier: classifier({ mode: 'standard', region: 'jp' }),
      snapshotId: () => '123e4567-e89b-42d3-a456-426614174000',
      now: () => '2026-01-02T03:04:06.000Z',
    });
    expect(result).toMatchObject({ kind: 'migrated', committedTarget: { mode: 'standard', region: 'jp' } });
    expect((await stateRepository.read()).value.committedTarget).toEqual({ mode: 'standard', region: 'jp' });
    const backup = await new BackupRepository({ root, mutationCoordinator: coordinator.capability }).read();
    expect(backup).toMatchObject({ kind: 'value', value: { schemaVersion: 4 } });
    expect(await readFile(result.evidencePath!)).toEqual(bytes);
  });

  it('leaves exact legacy bytes active when checked replacement fails before commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-migration-adapter-'));
    const bytes = legacyBytes();
    await writeFile(statePaths(root).backup, bytes);
    const filesystem = {
      ...nodeDurableFileSystem,
      replace: async () => { throw new Error('injected replace failure'); },
    };
    const store = new NodeLegacyBackupConversionStore({ root, filesystem });
    const parsed = parseLegacyBackupV3(bytes);
    expect(parsed.kind).toBe('complete');
    if (parsed.kind !== 'complete') return;
    await expect(store.replaceLegacy(bytes, {
      ...parsed.backup, snapshotId: '123e4567-e89b-42d3-a456-426614174000',
    })).rejects.toThrow();
    expect(await readFile(statePaths(root).backup)).toEqual(bytes);
  });

  it('restores exact active v3 bytes when the final real-adapter state commit fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-migration-adapter-'));
    const bytes = legacyBytes('eu');
    await writeFile(statePaths(root).backup, bytes);
    const coordinator = new InProcessTestMutationCoordinator();
    const state = new MemoryStateStore();
    state.failWrite = true;
    const result = await migrateLegacyProtection({
      root, coordinator: coordinator.capability, stateStore: state,
      backupStore: new NodeLegacyBackupConversionStore({ root }), evidenceStore: new NodeLegacyEvidenceStore(),
      classifier: classifier({ mode: 'deep', region: 'eu' }),
      snapshotId: () => '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(result).toMatchObject({ kind: 'recovery_required', reason: 'state_commit_failed' });
    expect(await readFile(statePaths(root).backup)).toEqual(bytes);
  });

  it('rejects invalid snapshots, missing inputs, and exact-byte mismatches before replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-migration-adapter-'));
    const store = new NodeLegacyBackupConversionStore({ root });
    expect(await store.readBytes()).toBeUndefined();
    await expect(store.replaceLegacy(legacyBytes(), {} as BackupSnapshotV4)).rejects.toThrow(/invalid/i);
    const parsed = parseLegacyBackupV3(legacyBytes());
    expect(parsed.kind).toBe('complete');
    if (parsed.kind !== 'complete') return;
    const snapshot = { ...parsed.backup, snapshotId: '123e4567-e89b-42d3-a456-426614174000' };
    await expect(store.replaceLegacy(legacyBytes(), snapshot)).rejects.toThrow(/changed/i);
    await writeFile(statePaths(root).backup, legacyBytes());
    await expect(store.replaceLegacy(Buffer.from('{}'), snapshot)).rejects.toThrow(/changed/i);
  });

  it('surfaces non-missing backup read I/O errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-migration-adapter-'));
    const filesystem = { ...nodeDurableFileSystem, readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
    await expect(new NodeLegacyBackupConversionStore({ root, filesystem }).readBytes()).rejects.toThrow('denied');
  });

  it('fails closed on an unknown newer state before touching legacy evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-migration-adapter-'));
    await writeFile(statePaths(root).backup, legacyBytes());
    await writeCheckedFile({
      stateRoot: root, filePath: statePaths(root).state, schema: 'cc-fix-state-v2',
      payload: { schemaVersion: 2 },
    });
    const coordinator = new InProcessTestMutationCoordinator();
    const evidence = new MemoryEvidenceStore();
    const result = await migrateLegacyProtection({
      root, coordinator: coordinator.capability,
      stateStore: new RepositoryMigrationStateStore(new StateRepository({ root, mutationCoordinator: coordinator.capability })),
      backupStore: new NodeLegacyBackupConversionStore({ root }), evidenceStore: evidence,
      classifier: classifier({ mode: 'deep', region: 'us' }),
    });
    expect(result).toMatchObject({ kind: 'failed', reason: 'state_read_failed', stateWritten: false });
    expect(evidence.calls).toBe(0);
  });

  it('preserves but rejects an unknown checked backup schema without falling back to US', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-migration-adapter-'));
    await writeCheckedFile({
      stateRoot: root, filePath: statePaths(root).backup, schema: 'cc-fix-backup-v5',
      payload: { schemaVersion: 5 },
    });
    const original = await readFile(statePaths(root).backup);
    const coordinator = new InProcessTestMutationCoordinator();
    const result = await migrateLegacyProtection({
      root, coordinator: coordinator.capability,
      stateStore: new RepositoryMigrationStateStore(new StateRepository({ root, mutationCoordinator: coordinator.capability })),
      backupStore: new NodeLegacyBackupConversionStore({ root }), evidenceStore: new NodeLegacyEvidenceStore(),
      classifier: classifier({ mode: 'deep', region: 'us' }),
    });
    expect(result).toMatchObject({ kind: 'failed', reason: 'legacy_invalid_shape', stateWritten: false });
    expect(await readFile(statePaths(root).backup)).toEqual(original);
    expect(await readFile(result.evidencePath!)).toEqual(original);
  });

  it('requires a nominal coordinator capability before any mutation or evidence write', async () => {
    const deps = setup();
    const result = await migrateLegacyProtection({
      root: 'C:\\state', coordinator: {} as never, stateStore: deps.state,
      backupStore: deps.backup, evidenceStore: deps.evidence,
      classifier: classifier({ mode: 'deep', region: 'us' }),
    });
    expect(result).toMatchObject({ kind: 'failed', reason: 'lock_required', stateWritten: false });
    expect(deps.evidence.calls).toBe(0);
    expect(deps.backup.writes).toBe(0);
    expect(deps.state.writes).toBe(0);
  });
});
