export type MutationAuditOperation =
  | 'state.initialize'
  | 'state.commit'
  | 'backup.create'
  | 'backup.delete'
  | 'backup.reconcile_delete';

export type MutationLockRequest = Readonly<{
  lockKey: string;
  stateRoot: string;
  filePath: string;
  operation: MutationAuditOperation;
}>;

export class CapabilityError extends Error {
  constructor(readonly code: 'INVALID_CAPABILITY' | 'LOCK_REENTRY', message: string) {
    super(message);
    this.name = 'CapabilityError';
  }
}

const lockContexts = new WeakSet<object>();
const coordinators = new WeakSet<object>();
const authorities = new WeakSet<object>();
const reservations = new WeakSet<object>();
const reservationLockKeys = new WeakMap<object, string>();
const issuerKey = Object.freeze({});

export type MutationLockBackend = { release(): Promise<void> };
export type MutationCoordinatorBackend = {
  acquire(request: MutationLockRequest): Promise<MutationLockBackend>;
};

export class MutationLockContext {
  readonly request: MutationLockRequest;
  #backend: MutationLockBackend;
  #released = false;

  constructor(request: MutationLockRequest, backend: MutationLockBackend, key: object) {
    if (key !== issuerKey) throw new CapabilityError('INVALID_CAPABILITY', 'Untrusted lock context issuer');
    this.request = Object.freeze({ ...request });
    this.#backend = backend;
    lockContexts.add(this);
  }

  async release(): Promise<void> {
    if (this.#released) return;
    await this.#backend.release();
    this.#released = true;
  }
}

export class MutationCoordinatorCapability {
  #backend: MutationCoordinatorBackend;

  constructor(backend: MutationCoordinatorBackend, key: object) {
    if (key !== issuerKey) throw new CapabilityError('INVALID_CAPABILITY', 'Untrusted coordinator issuer');
    this.#backend = backend;
    coordinators.add(this);
  }

  async acquire(request: MutationLockRequest): Promise<MutationLockContext> {
    return new MutationLockContext(request, await this.#backend.acquire(request), issuerKey);
  }
}

export function isMutationCoordinatorCapability(
  value: unknown,
): value is MutationCoordinatorCapability {
  return typeof value === 'object' && value !== null && coordinators.has(value);
}

export function isMutationLockContext(value: unknown): value is MutationLockContext {
  return typeof value === 'object' && value !== null && lockContexts.has(value);
}

export type VerifiedRestoreSnapshot = Readonly<{
  snapshotId: string;
  payloadFingerprint: string;
  generationIdentity: string;
}>;

declare const verifiedRestoreProofBrand: unique symbol;
export type VerifiedRestoreProof = { readonly [verifiedRestoreProofBrand]: never };

export type RestoreReservationBackend = object;
export type VerifiedRestoreAuthorityBackend = {
  reserve(
    lock: MutationLockContext,
    proof: VerifiedRestoreProof,
    snapshot: VerifiedRestoreSnapshot,
  ): Promise<{ kind: 'accepted'; reservation: RestoreReservationBackend } | { kind: 'rejected' }>;
  abort(lock: MutationLockContext, reservation: RestoreReservationBackend): Promise<void>;
  finalize(lock: MutationLockContext, reservation: RestoreReservationBackend): Promise<void>;
};

export class RestoreReservation {
  readonly snapshot: VerifiedRestoreSnapshot;
  readonly lockKey: string;
  #authority: VerifiedRestoreAuthorityCapability;
  #backend: RestoreReservationBackend;

  constructor(
    authority: VerifiedRestoreAuthorityCapability,
    backend: RestoreReservationBackend,
    snapshot: VerifiedRestoreSnapshot,
    key: object,
  ) {
    if (key !== issuerKey) throw new CapabilityError('INVALID_CAPABILITY', 'Untrusted reservation issuer');
    this.#authority = authority;
    this.#backend = backend;
    this.snapshot = Object.freeze({ ...snapshot });
    this.lockKey = authority.lockKeyForReservation(backend);
    reservations.add(this);
    Object.freeze(this);
  }

  belongsTo(authority: VerifiedRestoreAuthorityCapability): boolean {
    return this.#authority === authority;
  }

  backend(): RestoreReservationBackend {
    return this.#backend;
  }
}

export class VerifiedRestoreAuthorityCapability {
  #backend: VerifiedRestoreAuthorityBackend;

  constructor(backend: VerifiedRestoreAuthorityBackend, key: object) {
    if (key !== issuerKey) throw new CapabilityError('INVALID_CAPABILITY', 'Untrusted restore authority issuer');
    this.#backend = backend;
    authorities.add(this);
  }

  async reserve(
    lock: MutationLockContext,
    proof: VerifiedRestoreProof,
    snapshot: VerifiedRestoreSnapshot,
  ): Promise<RestoreReservation | undefined> {
    if (!isMutationLockContext(lock)) throw new CapabilityError('INVALID_CAPABILITY', 'Invalid lock context');
    const result = await this.#backend.reserve(lock, proof, snapshot);
    if (result.kind !== 'accepted') return undefined;
    reservationLockKeys.set(result.reservation, lock.request.lockKey);
    return new RestoreReservation(this, result.reservation, snapshot, issuerKey);
  }

  async abort(lock: MutationLockContext, reservation: RestoreReservation): Promise<void> {
    this.assertReservation(lock, reservation);
    await this.#backend.abort(lock, reservation.backend());
  }

  async finalize(lock: MutationLockContext, reservation: RestoreReservation): Promise<void> {
    this.assertReservation(lock, reservation);
    await this.#backend.finalize(lock, reservation.backend());
  }

  private assertReservation(lock: MutationLockContext, reservation: RestoreReservation): void {
    if (
      !isMutationLockContext(lock) ||
      !reservations.has(reservation) ||
      !reservation.belongsTo(this) ||
      reservation.lockKey !== lock.request.lockKey
    ) throw new CapabilityError('INVALID_CAPABILITY', 'Invalid restore reservation');
  }

  lockKeyForReservation(backend: RestoreReservationBackend): string {
    const lockKey = reservationLockKeys.get(backend);
    if (lockKey === undefined) throw new CapabilityError('INVALID_CAPABILITY', 'Unbound restore reservation');
    return lockKey;
  }
}

export function isVerifiedRestoreAuthorityCapability(
  value: unknown,
): value is VerifiedRestoreAuthorityCapability {
  return typeof value === 'object' && value !== null && authorities.has(value);
}

export function isRestoreReservation(value: unknown): value is RestoreReservation {
  return typeof value === 'object' && value !== null && reservations.has(value);
}

/** Internal issuer. This module is not exported from the package entrypoint. */
export function issueMutationCoordinatorCapability(
  backend: MutationCoordinatorBackend,
): MutationCoordinatorCapability {
  return new MutationCoordinatorCapability(backend, issuerKey);
}

/** Internal issuer. T11 will replace the test backend with durable restore verification. */
export function issueVerifiedRestoreAuthorityCapability(
  backend: VerifiedRestoreAuthorityBackend,
): VerifiedRestoreAuthorityCapability {
  return new VerifiedRestoreAuthorityCapability(backend, issuerKey);
}
