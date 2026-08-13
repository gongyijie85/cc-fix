import { describe, expect, it } from 'vitest';
import type { BackupRepository } from '../state/repository.js';
import { BACKUP_AUTHORITY_IDS, BROWSER_POLICY_SLOTS, storedMissing, storedValue, type BackupSnapshotV4 } from '../state/schema.js';
import { createVerifiedBackupDelete, createVerifiedBackupDeleteAuthority } from './verified-backup-delete.js';

function snapshot(): BackupSnapshotV4 {
  return {
    schemaVersion: 4, snapshotId: '7f60ed4b-bd54-4f9e-8c4c-c628a94b02a0', createdAt: '2026-08-13T00:00:00.000Z', complete: true,
    authoritySet: [...BACKUP_AUTHORITY_IDS],
    authorities: {
      environment: { TZ: storedMissing(), LANG: storedMissing(), LC_ALL: storedMissing() },
      systemTimezone: storedValue('UTC'),
      browserPolicies: Object.fromEntries(BROWSER_POLICY_SLOTS.map((slot) => [slot.id, { keyPath: slot.keyPath, valueName: slot.valueName, value: storedMissing() }])) as never,
      localeName: storedValue('en-US'), userLanguageList: storedValue(['en-US']), culture: storedValue('en-US'),
    },
  };
}

describe('verified backup delete application authority', () => {
  it('issues an opaque proof only at the post-verification callback and reconciles uncertain deletion', async () => {
    const issuer = createVerifiedBackupDeleteAuthority();
    let proof: unknown;
    const repository = {
      deleteAfterVerifiedRestore: async (value: unknown) => { proof = value; return { reservationState: 'reconcile_required', reservation: {} }; },
      reconcileVerifiedRestoreDeletion: async () => ({ kind: 'finalized' }),
    } as unknown as BackupRepository;
    await createVerifiedBackupDelete(repository, issuer)(snapshot());
    expect(proof).toEqual({});
  });

  it('returns directly after a committed deletion', async () => {
    const repository = {
      deleteAfterVerifiedRestore: async () => ({ reservationState: 'finalized' }),
      reconcileVerifiedRestoreDeletion: async () => { throw new Error('must not reconcile'); },
    } as unknown as BackupRepository;
    await expect(createVerifiedBackupDelete(repository, createVerifiedBackupDeleteAuthority())(snapshot())).resolves.toBeUndefined();
  });

  it('fails when uncertain deletion cannot be reconciled as finalized', async () => {
    const repository = {
      deleteAfterVerifiedRestore: async () => ({ reservationState: 'reconcile_required', reservation: {} }),
      reconcileVerifiedRestoreDeletion: async () => ({ kind: 'aborted' }),
    } as unknown as BackupRepository;
    await expect(createVerifiedBackupDelete(repository, createVerifiedBackupDeleteAuthority())(snapshot())).rejects.toThrow(/requires retry/i);
  });
});
