import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  type VerifiedRestoreProof,
  type VerifiedRestoreSnapshot,
} from './repository.js';
import {
  MutationCoordinatorCapability,
  MutationLockContext,
  RestoreReservation,
  VerifiedRestoreAuthorityCapability,
  issueMutationCoordinatorCapability,
  issueVerifiedRestoreAuthorityCapability,
  type VerifiedRestoreAuthorityCapability,
} from './internal/capabilities.js';
import { issueNativeCompareDeleteFilesystem } from './internal/native-compare-delete.js';
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

/** Test-only emulation; production Node intentionally cannot claim this T22 capability. */
function nativeCompareDeleteFilesystem(base: DurableFileSystem = nodeDurableFileSystem): DurableFileSystem {
  return issueNativeCompareDeleteFilesystem({
    ...base,
    compareDeleteCapability: 'native-compare-delete',
    compareAndDelete: async (path, expectedContents) => {
      let actual: string;
      try {
        actual = await base.readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
        throw error;
      }
      if (actual !== expectedContents) return 'mismatch';
      await base.unlink(path);
      return 'deleted';
    },
  });
}

const mutationCoordinator = new InProcessTestMutationCoordinator();

function stateRepository(root: string, options: Omit<RepositoryOptions, 'root'> = {}) {
  return new StateRepository({ ...options, root, mutationCoordinator: mutationCoordinator.capability });
}

function backupRepository(
  root: string,
  options: Omit<RepositoryOptions, 'root'> = {},
) {
  return new BackupRepository({ ...options, root, mutationCoordinator: mutationCoordinator.capability });
}

class FakeVerifiedRestoreAuthority {
  readonly capability: VerifiedRestoreAuthorityCapability;
  private readonly bindings = new WeakMap<object, VerifiedRestoreSnapshot & { state: 'available' | 'reserved' | 'finalized' }>();
  private readonly reservationBindings = new WeakMap<object, VerifiedRestoreSnapshot & { proof: object }>();
  onReserve?: () => Promise<void>;
  abortFailures = 0;
  finalizeFailures = 0;

  constructor() {
    this.capability = issueVerifiedRestoreAuthorityCapability({
      reserve: async (_lock, proof, snapshot) => {
        const binding = this.bindings.get(proof as object);
        if (
          binding === undefined ||
          binding.state !== 'available' ||
          binding.snapshotId !== snapshot.snapshotId ||
          binding.payloadFingerprint !== snapshot.payloadFingerprint ||
          binding.generationIdentity !== snapshot.generationIdentity
        ) return { kind: 'rejected' };
        binding.state = 'reserved';
        await this.onReserve?.();
        const reservation = {};
        this.reservationBindings.set(reservation, { ...snapshot, proof: proof as object });
        return { kind: 'accepted', reservation };
      },
      abort: async (_lock, reservation) => {
        if (this.abortFailures > 0) {
          this.abortFailures -= 1;
          throw new Error('injected abort failure');
        }
        const reserved = this.reservationBindings.get(reservation);
        if (reserved === undefined) throw new Error('invalid reservation');
        const binding = this.bindings.get(reserved.proof);
        if (binding === undefined || binding.state !== 'reserved') throw new Error('invalid reservation state');
        binding.state = 'available';
      },
      finalize: async (_lock, reservation) => {
        if (this.finalizeFailures > 0) {
          this.finalizeFailures -= 1;
          throw new Error('injected finalize failure');
        }
        const reserved = this.reservationBindings.get(reservation);
        if (reserved === undefined) throw new Error('invalid reservation');
        const binding = this.bindings.get(reserved.proof);
        if (binding === undefined || binding.state !== 'reserved') throw new Error('invalid reservation state');
        binding.state = 'finalized';
      },
    });
  }

  issue(snapshot: BackupSnapshotV4): VerifiedRestoreProof {
    const token = Object.freeze({});
    const payloadFingerprint = backupSnapshotFingerprint(snapshot);
    this.bindings.set(token, {
      snapshotId: snapshot.snapshotId,
      payloadFingerprint,
      generationIdentity: `${snapshot.snapshotId}:${payloadFingerprint}`,
      state: 'available',
    });
    return token as VerifiedRestoreProof;
  }
}

function verifiedBackupRepository(
  root: string,
  options: Omit<RepositoryOptions, 'root' | 'verifiedRestoreAuthority'> = {},
) {
  const verifier = new FakeVerifiedRestoreAuthority();
  const filesystem = nativeCompareDeleteFilesystem(options.filesystem ?? nodeDurableFileSystem);
  return {
    verifier,
    repository: backupRepository(root, { ...options, filesystem, verifiedRestoreAuthority: verifier.capability }),
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
    const unlockedDelete = new BackupRepository({ root, verifiedRestoreAuthority: verifier.capability });
    await expect(
      unlockedDelete.deleteAfterVerifiedRestore(verifier.issue(backupSnapshot())),
    ).rejects.toMatchObject({ code: 'LOCK_REQUIRED' });
  });

  it('rejects structural coordinator and restore-authority impostors at runtime', async () => {
    const root = await makeRoot();
    const structuralCoordinator = { acquire: async () => ({ release: async () => undefined }) };
    const state = new StateRepository({
      root,
      mutationCoordinator: structuralCoordinator as never,
    });
    await expect(state.initialize('us')).rejects.toMatchObject({ code: 'LOCK_REQUIRED' });

    const repository = new BackupRepository({
      root,
      mutationCoordinator: mutationCoordinator.capability,
      verifiedRestoreAuthority: { reserve: async () => ({}) } as never,
    });
    await repository.create(backupSnapshot());
    await expect(
      repository.deleteAfterVerifiedRestore({} as VerifiedRestoreProof),
    ).rejects.toMatchObject({ code: 'RESTORE_VERIFIER_REQUIRED' });
  });

  it('prevents direct minting and rejects invalid nominal lock or reservation tokens', async () => {
    const backendLock = { release: async () => undefined };
    const request = {
      lockKey: 'test',
      stateRoot: 'root',
      filePath: 'file',
      operation: 'backup.delete' as const,
    };
    expect(() => new MutationLockContext(request, backendLock, {})).toThrow('Untrusted lock');
    expect(
      () => new MutationCoordinatorCapability({ acquire: async () => backendLock }, {}),
    ).toThrow('Untrusted coordinator');
    expect(
      () => new VerifiedRestoreAuthorityCapability({} as never, {}),
    ).toThrow('Untrusted restore authority');
    expect(
      () => new RestoreReservation({} as never, {}, {
        snapshotId: 'id', payloadFingerprint: 'fingerprint', generationIdentity: 'generation',
      }, {}),
    ).toThrow('Untrusted reservation');

    const coordinator = new InProcessTestMutationCoordinator();
    const lock = await coordinator.capability.acquire(request);
    await lock.release();
    await lock.release();
    const verifier = new FakeVerifiedRestoreAuthority();
    await expect(
      verifier.capability.reserve({} as never, {} as VerifiedRestoreProof, {
        snapshotId: 'id', payloadFingerprint: 'fingerprint', generationIdentity: 'generation',
      }),
    ).rejects.toThrow('Invalid lock context');
    await expect(verifier.capability.abort(lock, {} as never)).rejects.toThrow('Invalid restore reservation');
  });

  it('retries a failed lock release and aggregates simultaneous mutation/release errors', async () => {
    let releaseCalls = 0;
    const retrying = issueMutationCoordinatorCapability({
      acquire: async () => ({
        release: async () => {
          releaseCalls += 1;
          if (releaseCalls === 1) throw new Error('first release failed');
        },
      }),
    });
    const request = {
      lockKey: 'release-test', stateRoot: 'root', filePath: 'file', operation: 'state.commit' as const,
    };
    const lock = await retrying.acquire(request);
    await expect(lock.release()).rejects.toThrow('first release failed');
    await expect(lock.release()).resolves.toBeUndefined();
    expect(releaseCalls).toBe(2);

    const root = await makeRoot();
    const failingRelease = issueMutationCoordinatorCapability({
      acquire: async () => ({ release: async () => { throw new Error('release failed'); } }),
    });
    const repository = new StateRepository({ root, mutationCoordinator: failingRelease });
    await expect(repository.commit(0, {
      committedTarget: null,
      preferredRegion: 'us',
      health: 'healthy',
      degradation: [],
      activeTransactionId: null,
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof RepositoryError &&
      error.code === 'IO_FAILED' &&
      error.cause instanceof AggregateError &&
      error.cause.errors.length === 2,
    );
  });

  it('keeps internal capability issuers out of production imports and the public entrypoint', async () => {
    const sourceRoot = join(process.cwd(), 'src');
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith('.ts')) files.push(path);
      }
    };
    await walk(sourceRoot);
    const productionImporters: string[] = [];
    const productionIssuerImporters: string[] = [];
    for (const path of files) {
      if (path.endsWith('.test.ts') || path.includes(`${join('state', 'test-support')}`)) continue;
      const source = await readFile(path, 'utf8');
      if (source.includes("./internal/capabilities.js") || source.includes("state/internal/capabilities")) {
        productionImporters.push(path.slice(sourceRoot.length + 1).replaceAll('\\', '/'));
      }
      if (
        !path.includes(join('state', 'internal')) &&
        /issue(?:MutationCoordinator|VerifiedRestoreAuthority|NativeCompareDelete)Capability|issueNativeCompareDeleteFilesystem/u.test(source)
      ) {
        productionIssuerImporters.push(path.slice(sourceRoot.length + 1).replaceAll('\\', '/'));
      }
    }
    expect(productionImporters).toEqual(['state/repository.ts']);
    expect(productionIssuerImporters).toEqual([]);
    expect(await readFile(join(sourceRoot, 'index.ts'), 'utf8')).not.toContain('state/internal');
  });

  it('grants queued test locks in FIFO order', async () => {
    const coordinator = new InProcessTestMutationCoordinator();
    const request = {
      lockKey: 'fifo', stateRoot: 'root', filePath: 'file', operation: 'state.commit' as const,
    };
    const first = await coordinator.capability.acquire(request);
    const order: number[] = [];
    const secondPromise = coordinator.capability.acquire(request).then((lock) => { order.push(2); return lock; });
    const thirdPromise = coordinator.capability.acquire(request).then((lock) => { order.push(3); return lock; });
    await first.release();
    const second = await secondPromise;
    await second.release();
    const third = await thirdPromise;
    await third.release();
    expect(order).toEqual([2, 3]);
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
    expect(mutationCoordinator.scopes.at(-1)).toMatchObject({
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

  it('uses one lock identity for state mutations while keeping operation as audit metadata', async () => {
    const root = await makeRoot();
    const coordinator = new InProcessTestMutationCoordinator();
    const repository = new StateRepository({ root, mutationCoordinator: coordinator.capability });
    await repository.initialize('us');
    await repository.commit(0, {
      committedTarget: null,
      preferredRegion: 'us',
      health: 'healthy',
      degradation: [],
      activeTransactionId: null,
    });
    expect(coordinator.requests.map(({ lockKey }) => lockKey)).toEqual([
      coordinator.requests[0]!.lockKey,
      coordinator.requests[0]!.lockKey,
    ]);
    expect(coordinator.requests.map(({ operation }) => operation)).toEqual([
      'state.initialize',
      'state.commit',
    ]);
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
        expectedIdentity: {
          snapshotId: '7f60ed4b-bd54-4f9e-8c4c-c628a94b02a0',
          payloadFingerprint: 'missing',
          generationIdentity: 'missing',
        },
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
    const repository = backupRepository(root, {
      verifiedRestoreAuthority: verifier.capability,
      filesystem: nativeCompareDeleteFilesystem(),
    });
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

  it('returns reconciliation when finalization fails and requires the same authority to finish', async () => {
    const root = await makeRoot();
    const { repository, verifier } = verifiedBackupRepository(root);
    const snapshot = backupSnapshot();
    await repository.create(snapshot);
    verifier.finalizeFailures = 1;
    const result = await repository.deleteAfterVerifiedRestore(verifier.issue(snapshot));
    expect(result).toMatchObject({ committed: true, reservationState: 'reconcile_required' });
    if (result.reservationState !== 'reconcile_required') throw new Error('expected reservation');
    const withoutAuthority = backupRepository(root, { filesystem: nativeCompareDeleteFilesystem() });
    await expect(
      withoutAuthority.reconcileVerifiedRestoreDeletion(result.reservation),
    ).rejects.toMatchObject({ code: 'RESTORE_VERIFIER_REQUIRED' });
    await expect(repository.reconcileVerifiedRestoreDeletion(result.reservation)).resolves.toEqual({
      kind: 'finalized',
    });
  });

  it('uses one backup lock identity for create and delete while auditing distinct operations', async () => {
    const root = await makeRoot();
    const coordinator = new InProcessTestMutationCoordinator();
    const verifier = new FakeVerifiedRestoreAuthority();
    const repository = new BackupRepository({
      root,
      mutationCoordinator: coordinator.capability,
      verifiedRestoreAuthority: verifier.capability,
      filesystem: nativeCompareDeleteFilesystem(),
    });
    const snapshot = backupSnapshot();
    await repository.create(snapshot);
    await repository.deleteAfterVerifiedRestore(verifier.issue(snapshot));
    expect(coordinator.requests[0]!.lockKey).toBe(coordinator.requests[1]!.lockKey);
    expect(coordinator.requests.map(({ operation }) => operation)).toEqual([
      'backup.create',
      'backup.delete',
    ]);
  });

  it('binds deletion to the accepted snapshot and never deletes a replacement', async () => {
    const root = await makeRoot();
    const verifier = new FakeVerifiedRestoreAuthority();
    const original = backupSnapshot();
    const replacement = {
      ...backupSnapshot(),
      snapshotId: '35d53e80-9b95-4c78-a8a8-6dc207341046',
      createdAt: '2026-08-11T12:00:01Z',
    };
    let replaced = false;
    const filesystem: DurableFileSystem = issueNativeCompareDeleteFilesystem({
      ...nativeCompareDeleteFilesystem(),
      compareAndDelete: async (path, expectedContents) => {
        if (!replaced) {
          replaced = true;
          await writeFile(
            path,
            serializeCheckedEnvelope(createCheckedEnvelope('cc-fix-backup-v4', replacement)),
            'utf8',
          );
        }
        const actual = await nodeDurableFileSystem.readFile(path);
        if (actual !== expectedContents) return 'mismatch';
        await nodeDurableFileSystem.unlink(path);
        return 'deleted';
      },
    });
    const repository = backupRepository(root, {
      verifiedRestoreAuthority: verifier.capability,
      filesystem,
    });
    await repository.create(original);
    await expect(
      repository.deleteAfterVerifiedRestore(verifier.issue(original)),
    ).rejects.toMatchObject({ code: 'DELETE_FAILED' });
    await expect(repository.read()).resolves.toMatchObject({
      kind: 'value',
      value: { snapshotId: replacement.snapshotId },
    });
  });

  it('rejects same-scope authority reentry promptly instead of recursively waiting', async () => {
    const root = await makeRoot();
    const verifier = new FakeVerifiedRestoreAuthority();
    const repository = backupRepository(root, {
      verifiedRestoreAuthority: verifier.capability,
      filesystem: nativeCompareDeleteFilesystem(),
    });
    const snapshot = backupSnapshot();
    await repository.create(snapshot);
    let reentryError: unknown;
    verifier.onReserve = async () => {
      try {
        await repository.create(snapshot);
      } catch (error) {
        reentryError = error;
      }
    };
    await repository.deleteAfterVerifiedRestore(verifier.issue(snapshot));
    expect(reentryError).toMatchObject({ code: 'LOCK_REENTRY' });
  });

  it.each([1, 2])('aborts the reservation and permits the same proof to retry after unlink #%i fails', async (faultAt) => {
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

    const proof = verifier.issue(snapshot);
    await expect(
      repository.deleteAfterVerifiedRestore(proof),
    ).rejects.toMatchObject({ code: 'DELETE_FAILED' });
    expect((await repository.read()).value).toEqual(snapshot);
    await expect(repository.deleteAfterVerifiedRestore(proof)).resolves.toMatchObject({
      committed: true,
      reservationState: 'finalized',
    });
  });

  it('fails closed on Node deletion because check-to-unlink is not atomic', async () => {
    const root = await makeRoot();
    const verifier = new FakeVerifiedRestoreAuthority();
    const repository = backupRepository(root, { verifiedRestoreAuthority: verifier.capability });
    const snapshot = backupSnapshot();
    await repository.create(snapshot);
    const proof = verifier.issue(snapshot);
    await expect(
      repository.deleteAfterVerifiedRestore(proof),
    ).rejects.toMatchObject({ code: 'DELETE_FAILED' });
    await expect(repository.read()).resolves.toMatchObject({
      kind: 'value', value: { snapshotId: snapshot.snapshotId },
    });
    const structuralSpoof: DurableFileSystem = {
      ...nodeDurableFileSystem,
      compareDeleteCapability: 'native-compare-delete',
      compareAndDelete: async () => 'deleted',
    };
    const spoofedRepository = backupRepository(root, {
      filesystem: structuralSpoof,
      verifiedRestoreAuthority: verifier.capability,
    });
    await expect(spoofedRepository.deleteAfterVerifiedRestore(proof)).rejects.toMatchObject({
      code: 'DELETE_FAILED',
    });
  });

  it('exposes an abort-failed reservation, rejects cross-root reconciliation before read, then retries the same proof', async () => {
    const rootA = await makeRoot();
    const rootB = await makeRoot();
    const snapshot = backupSnapshot();
    let unlinkCalls = 0;
    const faultFilesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      unlink: async (path) => {
        unlinkCalls += 1;
        if (unlinkCalls === 1) throw Object.assign(new Error('injected delete failure'), { code: 'EIO' });
        await nodeDurableFileSystem.unlink(path);
      },
    };
    const verifier = new FakeVerifiedRestoreAuthority();
    verifier.abortFailures = 1;
    const repositoryA = backupRepository(rootA, {
      filesystem: nativeCompareDeleteFilesystem(faultFilesystem),
      verifiedRestoreAuthority: verifier.capability,
    });
    await repositoryA.create(snapshot);
    const proof = verifier.issue(snapshot);
    let reservation: import('./repository.js').RestoreReservation | undefined;
    try {
      await repositoryA.deleteAfterVerifiedRestore(proof);
    } catch (error) {
      expect(error).toMatchObject({ code: 'DELETE_FAILED', reservationState: 'reconcile_required' });
      reservation = (error as { reservation?: import('./repository.js').RestoreReservation }).reservation;
    }
    expect(reservation).toBeDefined();

    let crossRootReads = 0;
    const crossRootFilesystem: DurableFileSystem = {
      ...nativeCompareDeleteFilesystem(),
      readFile: async (path) => {
        crossRootReads += 1;
        return nodeDurableFileSystem.readFile(path);
      },
    };
    const repositoryB = backupRepository(rootB, {
      filesystem: crossRootFilesystem,
      verifiedRestoreAuthority: verifier.capability,
    });
    await expect(repositoryB.reconcileVerifiedRestoreDeletion(reservation!)).rejects.toMatchObject({
      code: 'BACKUP_IDENTITY_MISMATCH',
    });
    expect(crossRootReads).toBe(0);

    await expect(repositoryA.reconcileVerifiedRestoreDeletion(reservation!)).resolves.toEqual({
      kind: 'preserved_retryable',
    });
    await expect(repositoryA.deleteAfterVerifiedRestore(proof)).resolves.toMatchObject({
      committed: true,
      reservationState: 'finalized',
    });
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
    const proof = verifier.issue(snapshot);
    const result = await repository.deleteAfterVerifiedRestore(proof);
    expect(result).toMatchObject({
      committed: true,
      possiblyDeleted: true,
      directoryDurability: 'unsupported',
      reservationState: 'reconcile_required',
    });
    if (result.reservationState !== 'reconcile_required') throw new Error('expected reservation');
    await expect(repository.reconcileVerifiedRestoreDeletion(result.reservation)).resolves.toEqual({ kind: 'finalized' });
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
    const result = await repository.deleteAfterVerifiedRestore(verifier.issue(snapshot));
    expect(result).toMatchObject({
      committed: true,
      possiblyDeleted: true,
      directoryDurability: 'unsupported',
      reservationState: 'reconcile_required',
    });
    if (result.reservationState !== 'reconcile_required') throw new Error('expected reservation');
    await expect(repository.reconcileVerifiedRestoreDeletion(result.reservation)).resolves.toEqual({ kind: 'finalized' });
  });

  it('preserves the final generation when native compare-delete fails before commit', async () => {
    const root = await makeRoot();
    const snapshot = backupSnapshot();
    let unlinkCalls = 0;
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      unlink: async (path) => {
        unlinkCalls += 1;
        if (unlinkCalls === 2) throw Object.assign(new Error('post-unlink failure'), { code: 'EIO' });
        await nodeDurableFileSystem.unlink(path);
      },
    };
    const { repository, verifier } = verifiedBackupRepository(root, { filesystem });
    await repository.create(snapshot);
    const proof = verifier.issue(snapshot);
    await expect(repository.deleteAfterVerifiedRestore(proof)).rejects.toMatchObject({
      code: 'DELETE_FAILED',
    });
    await expect(repository.read()).resolves.toMatchObject({ kind: 'value' });
  });

  it('reconciles when native final compare-delete removes the backup and then throws', async () => {
    const root = await makeRoot();
    const snapshot = backupSnapshot();
    let unlinkCalls = 0;
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      unlink: async (path) => {
        unlinkCalls += 1;
        await nodeDurableFileSystem.unlink(path);
        if (unlinkCalls === 2) {
          throw Object.assign(new Error('lost native completion response'), { code: 'EIO' });
        }
      },
    };
    const { repository, verifier } = verifiedBackupRepository(root, { filesystem });
    await repository.create(snapshot);
    const proof = verifier.issue(snapshot);

    const result = await repository.deleteAfterVerifiedRestore(proof);
    expect(result).toMatchObject({
      committed: true,
      possiblyDeleted: true,
      reservationState: 'reconcile_required',
    });
    await expect(repository.read()).resolves.toEqual({ kind: 'missing' });
    if (result.reservationState !== 'reconcile_required') throw new Error('expected reservation');
    await expect(repository.reconcileVerifiedRestoreDeletion(result.reservation)).resolves.toEqual({
      kind: 'finalized',
    });
  });

  it('keeps the reservation when a different valid backup appears after an uncertain final delete', async () => {
    const root = await makeRoot();
    const snapshot = backupSnapshot();
    const replacement: BackupSnapshotV4 = {
      ...backupSnapshot(),
      snapshotId: '3b825f6c-91f3-4a2a-a97a-132bce725413',
    };
    let unlinkCalls = 0;
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      unlink: async (path) => {
        unlinkCalls += 1;
        await nodeDurableFileSystem.unlink(path);
        if (unlinkCalls === 2) {
          await writeFile(
            path,
            serializeCheckedEnvelope(createCheckedEnvelope('cc-fix-backup-v4', replacement)),
            'utf8',
          );
          throw Object.assign(new Error('lost response after external replacement'), { code: 'EIO' });
        }
      },
    };
    const { repository, verifier } = verifiedBackupRepository(root, { filesystem });
    await repository.create(snapshot);
    const result = await repository.deleteAfterVerifiedRestore(verifier.issue(snapshot));

    expect(result).toMatchObject({
      committed: true,
      possiblyDeleted: true,
      reservationState: 'reconcile_required',
    });
    await expect(repository.read()).resolves.toMatchObject({
      kind: 'value',
      value: replacement,
    });
    if (result.reservationState !== 'reconcile_required') throw new Error('expected reservation');
    await expect(repository.reconcileVerifiedRestoreDeletion(result.reservation)).rejects.toMatchObject({
      code: 'BACKUP_IDENTITY_MISMATCH',
    });
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
