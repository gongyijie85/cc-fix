import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createCheckedEnvelope, serializeCheckedEnvelope } from './checksum.js';
import type { JsonValue } from './checksum.js';
import {
  deleteCheckedFile,
  nodeDurableFileSystem,
  type DurableFileSystem,
  writeCheckedFile,
} from './durable-file.js';
import {
  BACKUP_AUTHORITY_IDS,
  BROWSER_POLICY_SLOTS,
  isBackupSnapshotV4,
  storedMissing,
  storedValue,
  type BackupSnapshotV4,
  type ProtectionState,
} from './schema.js';
import {
  BackupRepository,
  backupSnapshotFingerprint,
  RepositoryError,
  StateRepository,
  type RepositoryOptions,
  type VerifiedRestoreAuthority,
  type VerifiedRestoreDecision,
  type VerifiedRestoreProof,
  type VerifiedRestoreSnapshot,
} from './repository.js';
import { statePaths } from './paths.js';
import { InProcessTestMutationCoordinator } from './test-support/in-process-mutation-coordinator.js';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cc-fix-state-repo-'));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function backupSnapshot(): BackupSnapshotV4 {
  return {
    schemaVersion: 4,
    snapshotId: '7f60ed4b-bd54-4f9e-8c4c-c628a94b02a0',
    createdAt: '2026-08-11T12:00:00Z',
    complete: true,
    authoritySet: [...BACKUP_AUTHORITY_IDS],
    authorities: {
      environment: { TZ: storedMissing(), LANG: storedValue(''), LC_ALL: storedValue(null) },
      systemTimezone: storedValue('UTC'),
      browserPolicies: Object.fromEntries(
        BROWSER_POLICY_SLOTS.map((slot) => [
          slot.id,
          { keyPath: slot.keyPath, valueName: slot.valueName, value: storedMissing() },
        ]),
      ) as BackupSnapshotV4['authorities']['browserPolicies'],
      localeName: storedValue('en-US'),
      userLanguageList: storedValue([]),
      culture: storedValue('en-US'),
    },
  };
}

const mutationCoordinator = new InProcessTestMutationCoordinator();

function stateRepository(root: string, options: Omit<RepositoryOptions, 'root'> = {}) {
  return new StateRepository({ ...options, root, mutationCoordinator });
}

function backupRepository(
  root: string,
  options: Omit<RepositoryOptions, 'root'> = {},
) {
  return new BackupRepository({ ...options, root, mutationCoordinator });
}

class FakeVerifiedRestoreAuthority implements VerifiedRestoreAuthority {
  private readonly bindings = new WeakMap<object, VerifiedRestoreSnapshot & { consumed: boolean }>();

  issue(snapshot: BackupSnapshotV4, generation: 'current' | 'previous' = 'current'): VerifiedRestoreProof {
    const token = Object.freeze({});
    this.bindings.set(token, {
      snapshotId: snapshot.snapshotId,
      payloadFingerprint: backupSnapshotFingerprint(snapshot),
      generation,
      consumed: false,
    });
    return token as VerifiedRestoreProof;
  }

  async consumeVerifiedRestore(
    proof: VerifiedRestoreProof,
    snapshot: VerifiedRestoreSnapshot,
  ): Promise<VerifiedRestoreDecision> {
    const binding = this.bindings.get(proof as object);
    if (binding === undefined) return { kind: 'rejected', reason: 'invalid' };
    if (binding.consumed) return { kind: 'rejected', reason: 'replayed' };
    if (
      binding.snapshotId !== snapshot.snapshotId ||
      binding.payloadFingerprint !== snapshot.payloadFingerprint ||
      binding.generation !== snapshot.generation
    ) return { kind: 'rejected', reason: 'snapshot_mismatch' };
    binding.consumed = true;
    return { kind: 'accepted' };
  }
}

function verifiedBackupRepository(
  root: string,
  options: Omit<RepositoryOptions, 'root' | 'verifiedRestoreAuthority'> = {},
) {
  const verifier = new FakeVerifiedRestoreAuthority();
  return {
    verifier,
    repository: backupRepository(root, { ...options, verifiedRestoreAuthority: verifier }),
  };
}

describe('StateRepository revisioned commits', () => {
  it('requires an injected mutation coordinator for every mutation API', async () => {
    const root = await makeRoot();
    const unlockedState = new StateRepository({ root });
    await expect(unlockedState.initialize('us')).rejects.toMatchObject({ code: 'LOCK_REQUIRED' });
    await expect(
      unlockedState.commit(0, {
        committedTarget: null,
        preferredRegion: 'us',
        health: 'healthy',
        degradation: [],
        activeTransactionId: null,
      }),
    ).rejects.toMatchObject({ code: 'LOCK_REQUIRED' });

    const unlockedBackup = new BackupRepository({ root });
    await expect(unlockedBackup.create(backupSnapshot())).rejects.toMatchObject({ code: 'LOCK_REQUIRED' });
    const verifier = new FakeVerifiedRestoreAuthority();
    const unlockedDelete = new BackupRepository({ root, verifiedRestoreAuthority: verifier });
    await expect(
      unlockedDelete.deleteAfterVerifiedRestore(verifier.issue(backupSnapshot())),
    ).rejects.toMatchObject({ code: 'LOCK_REQUIRED' });
  });

  it('centralizes fixed basenames and rejects non-literal roots', async () => {
    const root = await makeRoot();
    expect(statePaths(root)).toEqual({
      state: join(root, 'state.json'),
      backup: join(root, 'persist-backup.json'),
    });
    expect(() => statePaths('relative')).toThrow('absolute literal path');
  });

  it('initializes daily state and auto-increments an exact revision CAS commit', async () => {
    const root = await makeRoot();
    const repository = stateRepository(root, { now: () => '2026-08-11T12:00:00Z' });
    const initialized = await repository.initialize('eu');
    expect(initialized.value).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      committedTarget: null,
      preferredRegion: 'eu',
      health: 'healthy',
    });
    expect(initialized.boundarySafety).toBe('identity-checked');
    expect(mutationCoordinator.scopes.at(-1)).toEqual({
      stateRoot: root,
      filePath: statePaths(root).state,
      operation: 'state.initialize',
    });

    const committed = await repository.commit(0, {
      committedTarget: { mode: 'standard', region: 'jp' },
      preferredRegion: 'jp',
      health: 'healthy',
      degradation: [],
      activeTransactionId: null,
    });
    expect(committed.value.revision).toBe(1);
    expect((await repository.read()).value).toEqual(committed.value);
  });

  it('surfaces unsupported parent-directory durability to its caller', async () => {
    const root = await makeRoot();
    const repository = stateRepository(root, {
      filesystem: { ...nodeDurableFileSystem, directorySyncCapability: 'unsupported' },
    });
    await expect(repository.initialize('us')).resolves.toMatchObject({
      directoryDurability: 'unsupported',
      boundarySafety: 'identity-checked',
    });
  });

  it('allows only one of two concurrent commits at the same revision', async () => {
    const root = await makeRoot();
    const first = stateRepository(root, { now: () => '2026-08-11T12:00:00Z' });
    const second = stateRepository(root, { now: () => '2026-08-11T12:00:01Z' });
    await first.initialize('us');
    const mutation = {
      committedTarget: { mode: 'standard', region: 'us' } as const,
      preferredRegion: 'us' as const,
      health: 'healthy' as const,
      degradation: [],
      activeTransactionId: null,
    };

    const outcomes = await Promise.allSettled([
      first.commit(0, mutation),
      second.commit(0, { ...mutation, committedTarget: { mode: 'deep', region: 'eu' } }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(failure).toMatchObject({ reason: { code: 'REVISION_MISMATCH' } });
    expect((await first.read()).value.revision).toBe(1);
  });

  it('does not change committed state after revision mismatch', async () => {
    const root = await makeRoot();
    const repository = stateRepository(root);
    await repository.initialize('us');
    const before = (await repository.read()).value;
    await expect(
      repository.commit(9, {
        committedTarget: { mode: 'deep', region: 'sg' },
        preferredRegion: 'sg',
        health: 'healthy',
        degradation: [],
        activeTransactionId: null,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_MISMATCH' });
    expect((await repository.read()).value).toEqual(before);
  });

  it('rejects mutation accessors without invoking them', async () => {
    const root = await makeRoot();
    const repository = stateRepository(root);
    await repository.initialize('us');
    let getterCalls = 0;
    const mutation = {
      committedTarget: null,
      health: 'healthy',
      degradation: [],
      activeTransactionId: null,
    } as Record<string, unknown>;
    Object.defineProperty(mutation, 'preferredRegion', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'us';
      },
    });
    await expect(repository.commit(0, mutation as never)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(getterCalls).toBe(0);
    expect((await repository.read()).value.revision).toBe(0);
  });

  it('maps sparse mutation arrays to INVALID_STATE instead of IO', async () => {
    const root = await makeRoot();
    const repository = stateRepository(root);
    await repository.initialize('us');
    await expect(
      repository.commit(0, {
        committedTarget: null,
        preferredRegion: 'us',
        health: 'healthy',
        degradation: new Array(1) as never,
        activeTransactionId: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('rejects revision overflow without changing the stored state', async () => {
    const root = await makeRoot();
    const state: ProtectionState = {
      schemaVersion: 1,
      revision: Number.MAX_SAFE_INTEGER,
      committedTarget: null,
      preferredRegion: 'us',
      health: 'healthy',
      degradation: [],
      activeTransactionId: null,
      updatedAt: '2026-08-11T12:00:00Z',
    };
    await writeCheckedFile({
      stateRoot: root,
      filePath: statePaths(root).state,
      schema: 'cc-fix-state-v1',
      payload: state as unknown as JsonValue,
      validatePayload: (payload): payload is JsonValue => payload !== null,
    });
    const repository = stateRepository(root);
    await expect(
      repository.commit(Number.MAX_SAFE_INTEGER, {
        committedTarget: null,
        preferredRegion: 'us',
        health: 'healthy',
        degradation: [],
        activeTransactionId: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await repository.read()).value.revision).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns an immutable value detached from repository storage', async () => {
    const root = await makeRoot();
    const repository = stateRepository(root);
    await repository.initialize('us');
    const read = await repository.read();
    expect(() => {
      (read.value as ProtectionState).preferredRegion = 'eu';
    }).toThrow();
    expect((await repository.read()).value.preferredRegion).toBe('us');
  });

  it('marks valid predecessor recovery as degraded and blocks CAS', async () => {
    const root = await makeRoot();
    const repository = stateRepository(root);
    await repository.initialize('us');
    await repository.commit(0, {
      committedTarget: { mode: 'standard', region: 'us' },
      preferredRegion: 'us',
      health: 'healthy',
      degradation: [],
      activeTransactionId: null,
    });
    await writeFile(statePaths(root).state, '{corrupt', 'utf8');

    const recovered = await repository.read();
    expect(recovered).toMatchObject({
      source: 'previous',
      degraded: true,
      recoveredFromPredecessor: true,
    });
    await expect(
      repository.commit(recovered.value.revision, {
        committedTarget: null,
        preferredRegion: 'us',
        health: 'healthy',
        degradation: [],
        activeTransactionId: null,
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  });

  it('fails closed on missing or corrupt generations', async () => {
    const root = await makeRoot();
    const repository = stateRepository(root);
    await expect(
      repository.commit(0, {
        committedTarget: null,
        preferredRegion: 'us',
        health: 'healthy',
        degradation: [],
        activeTransactionId: null,
      }),
    ).rejects.toMatchObject({ code: 'STATE_MISSING' });

    await writeFile(statePaths(root).state, '{bad', 'utf8');
    await expect(repository.read()).rejects.toBeInstanceOf(RepositoryError);
  });

  it('fails closed on an unknown new state schema even with a valid predecessor', async () => {
    const root = await makeRoot();
    const repository = stateRepository(root);
    await repository.initialize('us');
    await copyFile(statePaths(root).state, `${statePaths(root).state}.prev`);
    await writeFile(
      statePaths(root).state,
      serializeCheckedEnvelope(createCheckedEnvelope('cc-fix-state-v2', { schemaVersion: 2 })),
      'utf8',
    );
    await expect(repository.read()).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
  });
});

describe('BackupRepository immutable snapshots', () => {
  it('checked deletion is a boundary-validated no-op when both fixed generations are missing', async () => {
    const root = await makeRoot();
    await expect(
      deleteCheckedFile({
        stateRoot: root,
        filePath: statePaths(root).backup,
        schema: 'cc-fix-backup-v4',
      }),
    ).resolves.toEqual({
      committed: true,
      possiblyDeleted: false,
      directoryDurability: 'durable',
      boundarySafety: 'identity-checked',
    });
  });

  it('creates once and refuses both identical and different overwrites', async () => {
    const root = await makeRoot();
    const repository = backupRepository(root);
    const snapshot = backupSnapshot();
    await repository.create(snapshot);
    await expect(repository.create(snapshot)).rejects.toMatchObject({ code: 'BACKUP_ALREADY_EXISTS' });
    await expect(
      repository.create({ ...snapshot, snapshotId: '4fa98a31-fdbc-4624-b7ce-c8b806e81e1e' }),
    ).rejects.toMatchObject({ code: 'BACKUP_ALREADY_EXISTS' });
    expect((await repository.read()).value).toEqual(snapshot);
  });

  it('rejects an invalid snapshot before writing any generation', async () => {
    const root = await makeRoot();
    const repository = backupRepository(root);
    const invalid = { ...backupSnapshot(), complete: false } as unknown as BackupSnapshotV4;
    await expect(repository.create(invalid)).rejects.toMatchObject({ code: 'INVALID_BACKUP' });
    await expect(repository.read()).resolves.toEqual({ kind: 'missing' });
  });

  it('rejects backup accessors without invoking them', async () => {
    const root = await makeRoot();
    const repository = backupRepository(root);
    let getterCalls = 0;
    const snapshot = backupSnapshot() as unknown as Record<string, unknown>;
    Object.defineProperty(snapshot, 'createdAt', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return '2026-08-11T12:00:00Z';
      },
    });
    await expect(repository.create(snapshot as unknown as BackupSnapshotV4)).rejects.toMatchObject({
      code: 'INVALID_BACKUP',
    });
    expect(getterCalls).toBe(0);
  });

  it('maps sparse backup arrays to INVALID_BACKUP instead of IO', async () => {
    const root = await makeRoot();
    const repository = backupRepository(root);
    const snapshot = backupSnapshot();
    snapshot.authoritySet = new Array(BACKUP_AUTHORITY_IDS.length) as never;
    await expect(repository.create(snapshot)).rejects.toMatchObject({ code: 'INVALID_BACKUP' });
  });

  it('refuses overwrite when only a valid predecessor remains', async () => {
    const root = await makeRoot();
    const repository = backupRepository(root);
    const snapshot = backupSnapshot();
    await repository.create(snapshot);
    // A same-payload durable write establishes a valid predecessor; corrupt current afterward.
    await writeCheckedFile({
      stateRoot: root,
      filePath: statePaths(root).backup,
      schema: 'cc-fix-backup-v4',
      payload: snapshot as unknown as JsonValue,
      validatePayload: (payload): payload is JsonValue => isBackupSnapshotV4(payload),
    });
    await writeFile(statePaths(root).backup, '{corrupt', 'utf8');
    await expect(repository.create(snapshot)).rejects.toMatchObject({ code: 'BACKUP_ALREADY_EXISTS' });
  });

  it('requires a verifier capability and rejects forged or mismatched opaque proofs', async () => {
    const root = await makeRoot();
    const snapshot = backupSnapshot();
    const withoutVerifier = backupRepository(root);
    await withoutVerifier.create(snapshot);
    await expect(
      withoutVerifier.deleteAfterVerifiedRestore({} as VerifiedRestoreProof),
    ).rejects.toMatchObject({ code: 'RESTORE_VERIFIER_REQUIRED' });

    const verifier = new FakeVerifiedRestoreAuthority();
    const repository = backupRepository(root, { verifiedRestoreAuthority: verifier });
    await expect(
      repository.deleteAfterVerifiedRestore({ futureTime: '2999-01-01' } as unknown as VerifiedRestoreProof),
    ).rejects.toMatchObject({ code: 'RESTORE_PROOF_INVALID' });
    const different = { ...snapshot, snapshotId: '4fa98a31-fdbc-4624-b7ce-c8b806e81e1e' };
    await expect(
      repository.deleteAfterVerifiedRestore(verifier.issue(different)),
    ).rejects.toMatchObject({ code: 'RESTORE_PROOF_INVALID' });
    const changedPayload = { ...snapshot, createdAt: '2026-08-11T12:00:01Z' };
    await expect(
      repository.deleteAfterVerifiedRestore(verifier.issue(changedPayload)),
    ).rejects.toMatchObject({ code: 'RESTORE_PROOF_INVALID' });
    await expect(
      repository.deleteAfterVerifiedRestore(verifier.issue(snapshot, 'previous')),
    ).rejects.toMatchObject({ code: 'RESTORE_PROOF_INVALID' });
    let getterCalls = 0;
    const accessorProof = Object.defineProperty({}, 'verifiedAt', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return '2999-01-01T00:00:00Z';
      },
    });
    await expect(
      repository.deleteAfterVerifiedRestore(accessorProof as VerifiedRestoreProof),
    ).rejects.toMatchObject({ code: 'RESTORE_PROOF_INVALID' });
    expect(getterCalls).toBe(0);
    expect((await repository.read()).value.snapshotId).toBe(snapshot.snapshotId);
  });

  it('consumes a matching opaque proof once and rejects replay after successful deletion', async () => {
    const root = await makeRoot();
    const { repository, verifier } = verifiedBackupRepository(root);
    const snapshot = backupSnapshot();
    await repository.create(snapshot);
    const proof = verifier.issue(snapshot);
    const result = await repository.deleteAfterVerifiedRestore(proof);
    expect(result.boundarySafety).toBe('identity-checked');
    expect(result).toMatchObject({ committed: true, possiblyDeleted: false });
    await expect(repository.read()).resolves.toEqual({ kind: 'missing' });
    await repository.create(snapshot);
    await expect(
      repository.deleteAfterVerifiedRestore(proof),
    ).rejects.toMatchObject({ code: 'RESTORE_PROOF_INVALID' });
  });

  it.each([1, 2])('retains a valid recoverable generation when verified deletion faults at unlink #%i', async (faultAt) => {
    const root = await makeRoot();
    const snapshot = backupSnapshot();
    let unlinkCalls = 0;
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      unlink: async (path) => {
        unlinkCalls += 1;
        if (unlinkCalls === faultAt) throw Object.assign(new Error('injected unlink fault'), { code: 'EIO' });
        await nodeDurableFileSystem.unlink(path);
      },
    };
    const { repository, verifier } = verifiedBackupRepository(root, { filesystem });
    await repository.create(snapshot);

    await expect(
      repository.deleteAfterVerifiedRestore(verifier.issue(snapshot)),
    ).rejects.toMatchObject({ code: 'DELETE_FAILED' });
    expect((await repository.read()).value).toEqual(snapshot);
  });

  it('reports committed deletion when the final unlink succeeds before boundary verification fails', async () => {
    const root = await makeRoot();
    const snapshot = backupSnapshot();
    let unlinkCalls = 0;
    let finalUnlinked = false;
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      unlink: async (path) => {
        unlinkCalls += 1;
        await nodeDurableFileSystem.unlink(path);
        if (unlinkCalls === 2) finalUnlinked = true;
      },
      lstat: async (path) => {
        const stat = await nodeDurableFileSystem.lstat(path);
        if (finalUnlinked && path === root) {
          return {
            isDirectory: () => stat.isDirectory(),
            isSymbolicLink: () => stat.isSymbolicLink(),
            dev: stat.dev,
            ino: stat.ino + 1n,
          };
        }
        return stat;
      },
    };
    const { repository, verifier } = verifiedBackupRepository(root, { filesystem });
    await repository.create(snapshot);
    await expect(repository.deleteAfterVerifiedRestore(verifier.issue(snapshot))).resolves.toMatchObject({
      committed: true,
      possiblyDeleted: true,
      directoryDurability: 'unsupported',
    });
  });

  it('reports committed deletion when final directory sync fails after unlink', async () => {
    const root = await makeRoot();
    const snapshot = backupSnapshot();
    let unlinkCalls = 0;
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      openDirectory: async (path) => {
        const handle = await nodeDurableFileSystem.openDirectory(path);
        return {
          close: () => handle.close(),
          sync: async () => {
            if (unlinkCalls === 2) {
              throw Object.assign(new Error('post-commit sync failure'), { code: 'EIO' });
            }
            await handle.sync();
          },
        };
      },
      unlink: async (path) => {
        unlinkCalls += 1;
        await nodeDurableFileSystem.unlink(path);
      },
    };
    const { repository, verifier } = verifiedBackupRepository(root, { filesystem });
    await repository.create(snapshot);
    await expect(repository.deleteAfterVerifiedRestore(verifier.issue(snapshot))).resolves.toMatchObject({
      committed: true,
      possiblyDeleted: true,
      directoryDurability: 'unsupported',
    });
  });

  it('reports a possibly committed deletion when final unlink deletes and then throws', async () => {
    const root = await makeRoot();
    const snapshot = backupSnapshot();
    let unlinkCalls = 0;
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      unlink: async (path) => {
        unlinkCalls += 1;
        await nodeDurableFileSystem.unlink(path);
        if (unlinkCalls === 2) throw Object.assign(new Error('post-unlink failure'), { code: 'EIO' });
      },
    };
    const { repository, verifier } = verifiedBackupRepository(root, { filesystem });
    await repository.create(snapshot);
    await expect(repository.deleteAfterVerifiedRestore(verifier.issue(snapshot))).resolves.toMatchObject({
      committed: true,
      possiblyDeleted: true,
      directoryDurability: 'unsupported',
    });
    await expect(repository.read()).resolves.toEqual({ kind: 'missing' });
  });

  it('fails closed on an unknown new backup schema even with a valid predecessor', async () => {
    const root = await makeRoot();
    const repository = backupRepository(root);
    await repository.create(backupSnapshot());
    await copyFile(statePaths(root).backup, `${statePaths(root).backup}.prev`);
    await writeFile(
      statePaths(root).backup,
      serializeCheckedEnvelope(createCheckedEnvelope('cc-fix-backup-v5', { schemaVersion: 5 })),
      'utf8',
    );
    await expect(repository.read()).rejects.toMatchObject({ code: 'BACKUP_CORRUPT' });
  });

  it('fails closed on a valid-checksum payload with an invalid backup schema', async () => {
    const root = await makeRoot();
    const invalid = { ...backupSnapshot(), complete: false };
    await writeFile(
      statePaths(root).backup,
      serializeCheckedEnvelope(createCheckedEnvelope('cc-fix-backup-v4', invalid)),
      'utf8',
    );
    const repository = backupRepository(root);
    await expect(repository.read()).rejects.toMatchObject({ code: 'BACKUP_CORRUPT' });
  });

  it('never touches unrelated user evidence', async () => {
    const root = await makeRoot();
    const evidence = join(root, '.wayfinder-temp-evidence');
    await writeFile(evidence, 'keep', 'utf8');
    const { repository, verifier } = verifiedBackupRepository(root);
    const snapshot = backupSnapshot();
    await repository.create(snapshot);
    await repository.deleteAfterVerifiedRestore(verifier.issue(snapshot));
    expect(await readFile(evidence, 'utf8')).toBe('keep');
  });
});
