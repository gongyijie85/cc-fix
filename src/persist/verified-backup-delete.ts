import type { BackupSnapshotV4 } from '../state/schema.js';
import {
  BackupRepository,
  backupSnapshotFingerprint,
  createVerifiedRestoreAuthorityCapability,
  type VerifiedRestoreProof,
  type VerifiedRestoreSnapshot,
} from '../state/repository.js';

type ProofBinding = {
  snapshotId: string;
  payloadFingerprint: string;
  state: 'available' | 'reserved' | 'finalized';
};

/** One runtime-scoped proof issuer; proof objects are opaque and one-use. */
export function createVerifiedBackupDeleteAuthority() {
  const proofs = new WeakMap<object, ProofBinding>();
  const reservations = new WeakMap<object, { proof: object; snapshot: VerifiedRestoreSnapshot }>();
  const capability = createVerifiedRestoreAuthorityCapability({
    reserve: async (_lock, proof, snapshot) => {
      const binding = proofs.get(proof as object);
      if (binding === undefined || binding.state !== 'available' ||
        binding.snapshotId !== snapshot.snapshotId ||
        binding.payloadFingerprint !== snapshot.payloadFingerprint) return { kind: 'rejected' };
      binding.state = 'reserved';
      const reservation = Object.freeze({});
      reservations.set(reservation, { proof: proof as object, snapshot });
      return { kind: 'accepted', reservation };
    },
    abort: async (_lock, reservation) => {
      const binding = reservations.get(reservation);
      if (binding === undefined) throw new Error('Unknown restore reservation');
      const proof = proofs.get(binding.proof);
      if (proof === undefined || proof.state !== 'reserved') throw new Error('Restore proof is not reserved');
      proof.state = 'available';
      reservations.delete(reservation);
    },
    finalize: async (_lock, reservation) => {
      const binding = reservations.get(reservation);
      if (binding === undefined) throw new Error('Unknown restore reservation');
      const proof = proofs.get(binding.proof);
      if (proof === undefined || proof.state !== 'reserved') throw new Error('Restore proof is not reserved');
      proof.state = 'finalized';
      reservations.delete(reservation);
    },
  });
  return {
    capability,
    issue: (snapshot: BackupSnapshotV4): VerifiedRestoreProof => {
      const proof = Object.freeze({});
      proofs.set(proof, {
        snapshotId: snapshot.snapshotId,
        payloadFingerprint: backupSnapshotFingerprint(snapshot),
        state: 'available',
      });
      return proof as VerifiedRestoreProof;
    },
  };
}

export function createVerifiedBackupDelete(
  repository: BackupRepository,
  issuer: ReturnType<typeof createVerifiedBackupDeleteAuthority>,
) {
  return async (snapshot: BackupSnapshotV4): Promise<void> => {
    const result = await repository.deleteAfterVerifiedRestore(issuer.issue(snapshot));
    if (result.reservationState === 'reconcile_required') {
      const reconciliation = await repository.reconcileVerifiedRestoreDeletion(result.reservation);
      if (reconciliation.kind !== 'finalized') {
        throw new Error('Verified backup deletion was preserved and requires retry');
      }
    }
  };
}
