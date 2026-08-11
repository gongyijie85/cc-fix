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
  RepositoryError,
  StateRepository,
} from './repository.js';
import { statePaths } from './paths.js';

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

describe('StateRepository revisioned commits', () => {
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
    const repository = new StateRepository({ root, now: () => '2026-08-11T12:00:00Z' });
    const initialized = await repository.initialize('eu');
    expect(initialized.value).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      committedTarget: null,
      preferredRegion: 'eu',
      health: 'healthy',
    });
    expect(initialized.boundarySafety).toBe('identity-checked');

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
    const repository = new StateRepository({
      root,
      filesystem: { ...nodeDurableFileSystem, directorySyncCapability: 'unsupported' },
    });
    await expect(repository.initialize('us')).resolves.toMatchObject({
      directoryDurability: 'unsupported',
      boundarySafety: 'identity-checked',
    });
  });

  it('allows only one of two concurrent commits at the same revision', async () => {
    const root = await makeRoot();
    const first = new StateRepository({ root, now: () => '2026-08-11T12:00:00Z' });
    const second = new StateRepository({ root, now: () => '2026-08-11T12:00:01Z' });
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
    const repository = new StateRepository({ root });
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

  it('returns an immutable value detached from repository storage', async () => {
    const root = await makeRoot();
    const repository = new StateRepository({ root });
    await repository.initialize('us');
    const read = await repository.read();
    expect(() => {
      (read.value as ProtectionState).preferredRegion = 'eu';
    }).toThrow();
    expect((await repository.read()).value.preferredRegion).toBe('us');
  });

  it('marks valid predecessor recovery as degraded and blocks CAS', async () => {
    const root = await makeRoot();
    const repository = new StateRepository({ root });
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
    expect(recovered).toMatchObject({ source: 'previous', degraded: true, recoveryRequired: true });
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
    const repository = new StateRepository({ root });
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
    const repository = new StateRepository({ root });
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
    ).resolves.toEqual({ directoryDurability: 'durable', boundarySafety: 'identity-checked' });
  });

  it('creates once and refuses both identical and different overwrites', async () => {
    const root = await makeRoot();
    const repository = new BackupRepository({ root });
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
    const repository = new BackupRepository({ root });
    const invalid = { ...backupSnapshot(), complete: false } as unknown as BackupSnapshotV4;
    await expect(repository.create(invalid)).rejects.toMatchObject({ code: 'INVALID_BACKUP' });
    await expect(repository.read()).resolves.toEqual({ kind: 'missing' });
  });

  it('refuses overwrite when only a valid predecessor remains', async () => {
    const root = await makeRoot();
    const repository = new BackupRepository({ root });
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

  it('rejects incomplete, mismatched or stale restore proof', async () => {
    const root = await makeRoot();
    const repository = new BackupRepository({ root });
    await repository.create(backupSnapshot());
    const receipt = {
      schemaVersion: 1 as const,
      snapshotId: backupSnapshot().snapshotId,
      restoreReceiptId: 'a8d83006-4549-4cbe-9fa7-6761fbf24a21',
      verifiedAt: '2026-08-11T13:00:00Z',
      completedAuthorities: [...BACKUP_AUTHORITY_IDS],
    };
    await expect(
      repository.deleteAfterVerifiedRestore({
        ...receipt,
        completedAuthorities: receipt.completedAuthorities.slice(1),
      }),
    ).rejects.toMatchObject({ code: 'RESTORE_PROOF_INVALID' });
    await expect(
      repository.deleteAfterVerifiedRestore({
        ...receipt,
        snapshotId: '4fa98a31-fdbc-4624-b7ce-c8b806e81e1e',
      }),
    ).rejects.toMatchObject({ code: 'RESTORE_PROOF_INVALID' });
    await expect(
      repository.deleteAfterVerifiedRestore({
        ...receipt,
        verifiedAt: '2026-08-11T11:59:59Z',
      }),
    ).rejects.toMatchObject({ code: 'RESTORE_PROOF_INVALID' });
    expect((await repository.read()).value.snapshotId).toBe(receipt.snapshotId);
  });

  it('deletes current and predecessor only after a complete matching receipt', async () => {
    const root = await makeRoot();
    const repository = new BackupRepository({ root });
    const snapshot = backupSnapshot();
    await repository.create(snapshot);
    const result = await repository.deleteAfterVerifiedRestore({
      schemaVersion: 1,
      snapshotId: snapshot.snapshotId,
      restoreReceiptId: 'a8d83006-4549-4cbe-9fa7-6761fbf24a21',
      verifiedAt: '2026-08-11T13:00:00Z',
      completedAuthorities: [...BACKUP_AUTHORITY_IDS],
    });
    expect(result.boundarySafety).toBe('identity-checked');
    await expect(repository.read()).resolves.toEqual({ kind: 'missing' });
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
    const repository = new BackupRepository({ root, filesystem });
    await repository.create(snapshot);

    await expect(
      repository.deleteAfterVerifiedRestore({
        schemaVersion: 1,
        snapshotId: snapshot.snapshotId,
        restoreReceiptId: 'a8d83006-4549-4cbe-9fa7-6761fbf24a21',
        verifiedAt: '2026-08-11T13:00:00Z',
        completedAuthorities: [...BACKUP_AUTHORITY_IDS],
      }),
    ).rejects.toMatchObject({ code: 'DELETE_FAILED' });
    expect((await repository.read()).value).toEqual(snapshot);
  });

  it('fails closed on an unknown new backup schema even with a valid predecessor', async () => {
    const root = await makeRoot();
    const repository = new BackupRepository({ root });
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
    const repository = new BackupRepository({ root });
    await expect(repository.read()).rejects.toMatchObject({ code: 'BACKUP_CORRUPT' });
  });

  it('never touches unrelated user evidence', async () => {
    const root = await makeRoot();
    const evidence = join(root, '.wayfinder-temp-evidence');
    await writeFile(evidence, 'keep', 'utf8');
    const repository = new BackupRepository({ root });
    const snapshot = backupSnapshot();
    await repository.create(snapshot);
    await repository.deleteAfterVerifiedRestore({
      schemaVersion: 1,
      snapshotId: snapshot.snapshotId,
      restoreReceiptId: 'a8d83006-4549-4cbe-9fa7-6761fbf24a21',
      verifiedAt: '2026-08-11T13:00:00Z',
      completedAuthorities: [...BACKUP_AUTHORITY_IDS],
    });
    expect(await readFile(evidence, 'utf8')).toBe('keep');
  });
});
