import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  CheckedEnvelopeError,
  canonicalJson,
  createCheckedEnvelope,
  decodeCheckedEnvelope,
  serializeCheckedEnvelope,
  type JsonValue,
} from './checksum.js';
import { isTrustedNativeCompareDeleteFilesystem } from './internal/native-compare-delete.js';

export interface DurableFileHandle {
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface DurableDirectoryHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface DurableFileStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  dev: bigint;
  ino: bigint;
}

export type DirectorySyncCapability = 'supported' | 'probe' | 'unsupported';
export type BoundarySafetyCapability = 'identity-checked' | 'native-no-follow';
export type CompareDeleteCapability = 'unsupported' | 'native-compare-delete';
export type DirectoryDurability = 'durable' | 'unsupported';

export interface DurableFileSystem {
  directorySyncCapability: DirectorySyncCapability;
  boundarySafety: BoundarySafetyCapability;
  compareDeleteCapability: CompareDeleteCapability;
  open(path: string, flags: string, mode?: number): Promise<DurableFileHandle>;
  openDirectory(path: string): Promise<DurableDirectoryHandle>;
  readFile(path: string): Promise<string>;
  lstat(path: string): Promise<DurableFileStat>;
  realpath(path: string): Promise<string>;
  /** Atomically replaces destination with a same-directory source when the platform supports it. */
  replace(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** T22 native primitive: atomically compare exact bytes and delete without a check/use gap. */
  compareAndDelete?(path: string, expectedContents: string): Promise<'deleted' | 'missing' | 'mismatch'>;
}

function asDurableHandle(handle: FileHandle): DurableFileHandle {
  return {
    writeFile: (data) => handle.writeFile(data, 'utf8').then(() => undefined),
    sync: () => handle.sync(),
    close: () => handle.close(),
  };
}

// EPERM is observed from Node/Windows directory fsync; EINVAL is covered as an explicit
// capability probe result. EBADF is never a capability signal because it means a bad handle.
const unsupportedDirectorySyncCodes = new Set(['EINVAL', 'EPERM']);

export const nodeDurableFileSystem: DurableFileSystem = {
  directorySyncCapability: process.platform === 'win32' ? 'probe' : 'supported',
  // Node cannot make traversal checks and the later open/rename one indivisible operation.
  // T22's native helper must provide native-no-follow for an adversarial same-user race.
  boundarySafety: 'identity-checked',
  compareDeleteCapability: 'unsupported',
  open: async (path, flags, mode) => asDurableHandle(await open(path, flags, mode)),
  openDirectory: async (path) => {
    const handle = await open(path, 'r');
    return { sync: () => handle.sync(), close: () => handle.close() };
  },
  readFile: (path) => readFile(path, 'utf8'),
  lstat: (path) => lstat(path, { bigint: true }),
  realpath,
  replace: rename,
  unlink,
};

export type DurableFileErrorCode =
  | 'INVALID_PATH'
  | 'REPARSE_BOUNDARY'
  | 'BOUNDARY_UNSUPPORTED'
  | 'INVALID_PAYLOAD'
  | 'CORRUPT'
  | 'BOTH_INVALID'
  | 'IO'
  | 'WRITE_FAILED'
  | 'DELETE_FAILED';

export class DurableFileError extends Error {
  readonly code: DurableFileErrorCode;
  readonly possiblyCommitted: boolean;

  constructor(
    code: DurableFileErrorCode,
    message: string,
    options?: ErrorOptions & { possiblyCommitted?: boolean },
  ) {
    super(message, options);
    this.name = 'DurableFileError';
    this.code = code;
    this.possiblyCommitted = options?.possiblyCommitted ?? false;
  }
}

interface CheckedFileOptions {
  stateRoot: string;
  filePath: string;
  schema: string;
  filesystem?: DurableFileSystem;
  requiredBoundarySafety?: BoundarySafetyCapability;
}

export interface WriteCheckedFileOptions<T extends JsonValue> extends CheckedFileOptions {
  payload: T;
  validatePayload?: (payload: JsonValue) => boolean;
}

export interface DurableWriteResult {
  /** `unsupported` means file sync and replace completed, but parent-directory flush was unavailable. */
  directoryDurability: DirectoryDurability;
  /** Node provides detectable identity-race checks, not an atomic native no-follow guarantee. */
  boundarySafety: BoundarySafetyCapability;
}

export interface DurableDeleteResult extends DurableWriteResult {
  /** True once both generations are observed absent or the final unlink returns successfully. */
  committed: boolean;
  /** True when the final unlink boundary was crossed but post-commit durability is uncertain. */
  possiblyDeleted: boolean;
}

export type CheckedFileReadResult<T extends JsonValue> =
  | { kind: 'missing' }
  | {
      kind: 'ok';
      source: 'current' | 'previous';
      degraded: boolean;
      payload: T;
      currentFailure?: GenerationFailure;
    };

export interface ReadCheckedFileOptions<T extends JsonValue> extends CheckedFileOptions {
  validatePayload?: (payload: JsonValue) => payload is T;
}

export interface DeleteCheckedFileOptions<T extends JsonValue> extends CheckedFileOptions {
  validatePayload?: (payload: JsonValue) => payload is T;
  expectedIdentity: CheckedPayloadIdentity;
}

export type CheckedPayloadIdentity = Readonly<{
  snapshotId: string;
  payloadFingerprint: string;
  generationIdentity: string;
}>;

export function checkedPayloadIdentity(payload: JsonValue): CheckedPayloadIdentity {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    typeof payload.snapshotId !== 'string'
  ) {
    throw new DurableFileError('INVALID_PAYLOAD', 'Checked deletion payload requires a snapshot id');
  }
  const payloadFingerprint = createHash('sha256').update(canonicalJson(payload)).digest('hex');
  return Object.freeze({
    snapshotId: payload.snapshotId,
    payloadFingerprint,
    generationIdentity: `${payload.snapshotId}:${payloadFingerprint}`,
  });
}

function assertExpectedIdentity(payload: JsonValue, expected: CheckedPayloadIdentity): void {
  const actual = checkedPayloadIdentity(payload);
  if (
    actual.snapshotId !== expected.snapshotId ||
    actual.payloadFingerprint !== expected.payloadFingerprint ||
    actual.generationIdentity !== expected.generationIdentity
  ) {
    throw new DurableFileError('DELETE_FAILED', 'Checked deletion identity changed', {
      possiblyCommitted: false,
    });
  }
}

export interface GenerationFailure {
  kind: 'missing' | 'corrupt' | 'io';
  path: string;
  cause?: unknown;
}

type GenerationRead<T extends JsonValue> =
  | { kind: 'valid'; payload: T }
  | GenerationFailure;

interface BoundarySnapshot {
  rootPath: string;
  parentPath: string;
  rootRealPath: string;
  parentRealPath: string;
  rootIdentity: string;
  parentIdentity: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function requireBoundaryCapability(
  required: BoundarySafetyCapability | undefined,
  filesystem: DurableFileSystem,
): void {
  if (required === 'native-no-follow' && filesystem.boundarySafety !== 'native-no-follow') {
    throw new DurableFileError(
      'BOUNDARY_UNSUPPORTED',
      'The filesystem adapter cannot provide native no-follow boundary safety',
    );
  }
}

async function syncDirectoryDurably(
  directory: string,
  filesystem: DurableFileSystem,
): Promise<DirectoryDurability> {
  if (filesystem.directorySyncCapability === 'unsupported') return 'unsupported';

  const handle = await filesystem.openDirectory(directory);
  let primaryError: unknown;
  let probeError: unknown;
  let result: DirectoryDurability = 'durable';
  try {
    await handle.sync();
  } catch (error) {
    if (
      filesystem.directorySyncCapability === 'probe' &&
      isNodeError(error) &&
      unsupportedDirectorySyncCodes.has(error.code)
    ) {
      probeError = error;
      result = 'unsupported';
    } else {
      primaryError = error;
    }
  }

  try {
    await handle.close();
  } catch (closeError) {
    const precedingError = primaryError ?? probeError;
    if (precedingError !== undefined) {
      throw new AggregateError(
        [precedingError, closeError],
        'Directory sync and directory close both failed',
      );
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
  return result;
}

function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]+/u).some((segment) => segment === '..');
}

const windowsReservedAlias =
  /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/iu;

/** Validates Win32 literal-path syntax without resolving or touching the filesystem. */
export function validateWindowsLiteralPathSyntax(path: string): void {
  if (
    !/^[A-Za-z]:[\\/]/u.test(path) ||
    /^[\\/]{2}/u.test(path) ||
    path.includes('\0') ||
    path.slice(2).includes(':')
  ) {
    throw new DurableFileError(
      'INVALID_PATH',
      'Windows state paths must use a local drive and cannot use device, UNC, or ADS syntax',
    );
  }

  const segments = path.slice(3).split(/[\\/]/u);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        /[. ]$/u.test(segment) ||
        /[<>"|?*\u0000-\u001f]/u.test(segment) ||
        windowsReservedAlias.test(segment),
    )
  ) {
    throw new DurableFileError(
      'INVALID_PATH',
      'Windows state paths cannot contain empty, alias, reserved, or trailing-dot/space segments',
    );
  }
}

function canonicalPath(path: string): string {
  return resolve(path).replace(/[\\/]+$/u, '');
}

function normalizedForComparison(path: string): string {
  const normalized = canonicalPath(path);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function isStrictDescendant(root: string, target: string): boolean {
  const normalizedRoot = normalizedForComparison(root);
  const normalizedTarget = normalizedForComparison(target);
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return normalizedTarget.startsWith(prefix);
}

function stableIdentity(stat: DurableFileStat): string {
  if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint') {
    throw new DurableFileError(
      'BOUNDARY_UNSUPPORTED',
      'The filesystem adapter does not expose stable directory identity',
    );
  }
  return `${String(stat.dev)}:${String(stat.ino)}`;
}

function isCanonicalWithinRoot(
  realRoot: string,
  candidate: string,
  rootIdentity: string,
  candidateIdentity: string,
): boolean {
  const canonicalRoot = canonicalPath(realRoot);
  const canonicalCandidate = canonicalPath(candidate);
  if (canonicalCandidate === canonicalRoot) return candidateIdentity === rootIdentity;
  if (canonicalCandidate.startsWith(`${canonicalRoot}${sep}`)) return true;
  return (
    normalizedForComparison(canonicalCandidate) === normalizedForComparison(canonicalRoot) &&
    candidateIdentity === rootIdentity
  );
}

function isSameBoundaryPath(
  actual: string,
  expected: string,
  actualIdentity: string,
  expectedIdentity: string,
): boolean {
  return (
    canonicalPath(actual) === canonicalPath(expected) ||
    (normalizedForComparison(actual) === normalizedForComparison(expected) &&
      actualIdentity === expectedIdentity)
  );
}

async function assertBoundaryStable(
  snapshot: BoundarySnapshot,
  filesystem: DurableFileSystem,
): Promise<void> {
  for (const [path, expectedRealPath, expectedIdentity] of [
    [snapshot.rootPath, snapshot.rootRealPath, snapshot.rootIdentity],
    [snapshot.parentPath, snapshot.parentRealPath, snapshot.parentIdentity],
  ] as const) {
    const stat = await filesystem.lstat(path);
    const realPath = await filesystem.realpath(path);
    const actualIdentity = stableIdentity(stat);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !isSameBoundaryPath(realPath, expectedRealPath, actualIdentity, expectedIdentity) ||
      actualIdentity !== expectedIdentity
    ) {
      throw new DurableFileError(
        'REPARSE_BOUNDARY',
        `State boundary identity changed during the operation: ${path}`,
      );
    }
  }
}

async function validateSafeTarget(
  stateRoot: string,
  filePath: string,
  filesystem: DurableFileSystem,
): Promise<BoundarySnapshot> {
  if (process.platform === 'win32') {
    validateWindowsLiteralPathSyntax(stateRoot);
    validateWindowsLiteralPathSyntax(filePath);
  }
  if (
    !isAbsolute(stateRoot) ||
    !isAbsolute(filePath) ||
    hasParentSegment(stateRoot) ||
    hasParentSegment(filePath) ||
    !isStrictDescendant(stateRoot, filePath)
  ) {
    throw new DurableFileError(
      'INVALID_PATH',
      'State paths must be absolute literal descendants of the supplied state root',
    );
  }

  const absoluteRoot = resolve(stateRoot);
  const absoluteTarget = resolve(filePath);
  try {
    const rootStat = await filesystem.lstat(absoluteRoot);
    if (rootStat.isSymbolicLink()) {
      throw new DurableFileError('REPARSE_BOUNDARY', 'The supplied state root is a reparse point');
    }
    if (!rootStat.isDirectory()) {
      throw new DurableFileError('INVALID_PATH', 'The supplied state root is not a directory');
    }
    const realRoot = await filesystem.realpath(absoluteRoot);
    const rootIdentity = stableIdentity(rootStat);

    const segments = relative(absoluteRoot, absoluteTarget).split(/[\\/]+/u);
    let cursor = absoluteRoot;
    for (const segment of segments) {
      cursor = resolve(cursor, segment);
      try {
        const stat = await filesystem.lstat(cursor);
        if (stat.isSymbolicLink()) {
          throw new DurableFileError(
            'REPARSE_BOUNDARY',
            `State path crosses a reparse point: ${cursor}`,
          );
        }
        const realCursor = await filesystem.realpath(cursor);
        if (!isCanonicalWithinRoot(realRoot, realCursor, rootIdentity, stableIdentity(stat))) {
          throw new DurableFileError(
            'REPARSE_BOUNDARY',
            `State path resolves outside the supplied state root: ${cursor}`,
          );
        }
      } catch (error) {
        if (isMissing(error)) break;
        throw error;
      }
    }

    const parentPath = dirname(absoluteTarget);
    const parentStat = await filesystem.lstat(parentPath);
    if (parentStat.isSymbolicLink()) {
      throw new DurableFileError('REPARSE_BOUNDARY', 'The state-file parent is a reparse point');
    }
    if (!parentStat.isDirectory()) {
      throw new DurableFileError('INVALID_PATH', 'The state-file parent is not a directory');
    }
    const realParent = await filesystem.realpath(parentPath);
    if (!isCanonicalWithinRoot(realRoot, realParent, rootIdentity, stableIdentity(parentStat))) {
      throw new DurableFileError(
        'REPARSE_BOUNDARY',
        'The state-file parent resolves outside the supplied state root',
      );
    }
    return {
      rootPath: absoluteRoot,
      parentPath,
      rootRealPath: realRoot,
      parentRealPath: realParent,
      rootIdentity,
      parentIdentity: stableIdentity(parentStat),
    };
  } catch (error) {
    if (error instanceof DurableFileError) throw error;
    throw new DurableFileError('IO', 'Unable to validate the state path boundary', { cause: error });
  }
}

/**
 * Reuses the checked-file root/reparse/identity validation for adjacent state
 * artifacts that deliberately are not checked envelopes (for example the
 * byte-for-byte legacy migration evidence). Call again after any filesystem
 * operation that may create or replace a path segment.
 */
export async function validateDurablePathBoundary(
  stateRoot: string,
  filePath: string,
  filesystem: DurableFileSystem = nodeDurableFileSystem,
  requiredBoundarySafety?: BoundarySafetyCapability,
): Promise<void> {
  requireBoundaryCapability(requiredBoundarySafety, filesystem);
  await validateSafeTarget(stateRoot, filePath, filesystem);
}

async function readGeneration<T extends JsonValue>(
  path: string,
  schema: string,
  filesystem: DurableFileSystem,
  boundary: BoundarySnapshot,
  validatePayload?: (payload: JsonValue) => boolean,
): Promise<GenerationRead<T>> {
  await assertBoundaryStable(boundary, filesystem);
  let serialized: string | undefined;
  let readError: unknown;
  try {
    serialized = await filesystem.readFile(path);
  } catch (error) {
    readError = error;
  }
  await assertBoundaryStable(boundary, filesystem);
  if (readError !== undefined) {
    return isMissing(readError)
      ? { kind: 'missing', path, cause: readError }
      : { kind: 'io', path, cause: readError };
  }
  if (serialized === undefined) {
    return { kind: 'io', path, cause: new Error('Filesystem returned no checked-file bytes') };
  }

  let envelope;
  try {
    envelope = decodeCheckedEnvelope<T>(serialized, schema);
  } catch (error) {
    if (error instanceof CheckedEnvelopeError) {
      return { kind: 'corrupt', path, cause: error };
    }
    return { kind: 'io', path, cause: error };
  }
  if (validatePayload !== undefined) {
    try {
      if (!validatePayload(envelope.payload)) {
        return { kind: 'corrupt', path, cause: new Error('Payload schema validation failed') };
      }
    } catch (error) {
      return { kind: 'corrupt', path, cause: error };
    }
  }
  return { kind: 'valid', payload: envelope.payload };
}

export async function readCheckedFile<T extends JsonValue = JsonValue>(
  options: ReadCheckedFileOptions<T>,
): Promise<CheckedFileReadResult<T>> {
  const filesystem = options.filesystem ?? nodeDurableFileSystem;
  requireBoundaryCapability(options.requiredBoundarySafety, filesystem);
  const currentBoundary = await validateSafeTarget(options.stateRoot, options.filePath, filesystem);

  const current = await readGeneration<T>(
    options.filePath,
    options.schema,
    filesystem,
    currentBoundary,
    options.validatePayload,
  );
  if (current.kind === 'valid') {
    return { kind: 'ok', source: 'current', degraded: false, payload: current.payload };
  }

  const previousPath = `${options.filePath}.prev`;
  const previousBoundary = await validateSafeTarget(options.stateRoot, previousPath, filesystem);
  const previous = await readGeneration<T>(
    previousPath,
    options.schema,
    filesystem,
    previousBoundary,
    options.validatePayload,
  );
  if (previous.kind === 'valid') {
    return {
      kind: 'ok',
      source: 'previous',
      degraded: true,
      payload: previous.payload,
      currentFailure: current,
    };
  }
  if (current.kind === 'missing' && previous.kind === 'missing') {
    return { kind: 'missing' };
  }
  if (current.kind === 'io' || previous.kind === 'io') {
    throw new DurableFileError('IO', 'No valid checked generation could be read due to I/O failure', {
      cause: current.kind === 'io' ? current.cause : previous.cause,
    });
  }
  if (current.kind === 'corrupt' && previous.kind === 'corrupt') {
    throw new DurableFileError('BOTH_INVALID', 'Current and previous checked generations are corrupt');
  }
  throw new DurableFileError('CORRUPT', 'No valid checked generation is available', {
    cause: current.kind === 'corrupt' ? current.cause : previous.cause,
  });
}

async function removeOwnedTemp(
  path: string,
  boundary: BoundarySnapshot,
  filesystem: DurableFileSystem,
): Promise<void> {
  try {
    await assertBoundaryStable(boundary, filesystem);
    await filesystem.unlink(path);
  } catch (error) {
    if (isMissing(error)) return;
    // Never follow a changed boundary just to clean up. A confirmed operation-owned remnant is
    // intentionally left as evidence; T21 diagnostics will surface such remnants to the user.
  }
}

async function prepareTemp(
  destination: string,
  serialized: string,
  filesystem: DurableFileSystem,
  boundary: BoundarySnapshot,
  ownedTemps: Map<string, BoundarySnapshot>,
): Promise<string> {
  const tempPath = `${destination}.cc-fix-tmp-${process.pid}-${randomUUID()}`;
  let handle: DurableFileHandle | undefined;
  let primaryError: unknown;
  try {
    await assertBoundaryStable(boundary, filesystem);
    handle = await filesystem.open(tempPath, 'wx', 0o600);
    ownedTemps.set(tempPath, boundary);
    await assertBoundaryStable(boundary, filesystem);
    await handle.writeFile(serialized);
    await handle.sync();
    await assertBoundaryStable(boundary, filesystem);
  } catch (error) {
    primaryError = error;
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (closeError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, closeError],
          'Temporary-file operation and close both failed',
        );
      }
      throw closeError;
    }
  }
  if (primaryError !== undefined) throw primaryError;
  return tempPath;
}

export async function writeCheckedFile<T extends JsonValue>(
  options: WriteCheckedFileOptions<T>,
): Promise<DurableWriteResult> {
  const filesystem = options.filesystem ?? nodeDurableFileSystem;
  requireBoundaryCapability(options.requiredBoundarySafety, filesystem);
  const currentBoundary = await validateSafeTarget(
    options.stateRoot,
    options.filePath,
    filesystem,
  );

  if (options.validatePayload !== undefined) {
    try {
      if (!options.validatePayload(options.payload)) {
        throw new DurableFileError(
          'INVALID_PAYLOAD',
          'New checked-file payload failed schema validation',
        );
      }
    } catch (error) {
      if (error instanceof DurableFileError) throw error;
      throw new DurableFileError('INVALID_PAYLOAD', 'Payload schema validator failed', {
        cause: error,
      });
    }
  }

  const ownedTemps = new Map<string, BoundarySnapshot>();
  let finalReplaceAttempted = false;
  let directoryDurability: DirectoryDurability = 'durable';
  try {
    const nextSerialized = serializeCheckedEnvelope(
      createCheckedEnvelope(options.schema, options.payload),
    );
    const nextTemp = await prepareTemp(
      options.filePath,
      nextSerialized,
      filesystem,
      currentBoundary,
      ownedTemps,
    );

    const current = await readGeneration<T>(
      options.filePath,
      options.schema,
      filesystem,
      currentBoundary,
      options.validatePayload,
    );
    if (current.kind === 'io') throw current.cause;
    if (current.kind === 'valid') {
      const previousPath = `${options.filePath}.prev`;
      const previousBoundary = await validateSafeTarget(
        options.stateRoot,
        previousPath,
        filesystem,
      );
      const previousSerialized = serializeCheckedEnvelope(
        createCheckedEnvelope(options.schema, current.payload),
      );
      const previousTemp = await prepareTemp(
        previousPath,
        previousSerialized,
        filesystem,
        previousBoundary,
        ownedTemps,
      );
      await assertBoundaryStable(previousBoundary, filesystem);
      await filesystem.replace(previousTemp, previousPath);
      await assertBoundaryStable(previousBoundary, filesystem);
      ownedTemps.delete(previousTemp);
      if ((await syncDirectoryDurably(dirname(previousPath), filesystem)) === 'unsupported') {
        directoryDurability = 'unsupported';
      }
    }

    await assertBoundaryStable(currentBoundary, filesystem);
    finalReplaceAttempted = true;
    await filesystem.replace(nextTemp, options.filePath);
    await assertBoundaryStable(currentBoundary, filesystem);
    ownedTemps.delete(nextTemp);
    if ((await syncDirectoryDurably(dirname(options.filePath), filesystem)) === 'unsupported') {
      directoryDurability = 'unsupported';
    }
  } catch (error) {
    throw new DurableFileError('WRITE_FAILED', 'Durable checked-file write failed', {
      cause: error,
      possiblyCommitted: finalReplaceAttempted,
    });
  } finally {
    await Promise.all(
      [...ownedTemps].map(([path, boundary]) => removeOwnedTemp(path, boundary, filesystem)),
    );
  }
  return { directoryDurability, boundarySafety: filesystem.boundarySafety };
}

/** Deletes only a validated checked file and its fixed predecessor generation. */
export async function deleteCheckedFile<T extends JsonValue>(
  options: DeleteCheckedFileOptions<T>,
): Promise<DurableDeleteResult> {
  const filesystem = options.filesystem ?? nodeDurableFileSystem;
  requireBoundaryCapability(options.requiredBoundarySafety, filesystem);
  const readable = await readCheckedFile(options);
  if (readable.kind === 'missing') {
    return {
      committed: true,
      possiblyDeleted: false,
      directoryDurability: 'durable',
      boundarySafety: filesystem.boundarySafety,
    };
  }
  if (
    filesystem.compareDeleteCapability !== 'native-compare-delete' ||
    filesystem.compareAndDelete === undefined ||
    !isTrustedNativeCompareDeleteFilesystem(filesystem)
  ) {
    throw new DurableFileError(
      'BOUNDARY_UNSUPPORTED',
      'Checked deletion requires an atomic native compare-and-delete adapter',
    );
  }
  const compareAndDelete = filesystem.compareAndDelete.bind(filesystem);
  assertExpectedIdentity(readable.payload, options.expectedIdentity);

  let directoryDurability: DirectoryDurability;
  try {
    const preparation = await writeCheckedFile({
      ...options,
      payload: readable.payload,
    });
    directoryDurability = preparation.directoryDurability;
  } catch (error) {
    throw new DurableFileError(
      'DELETE_FAILED',
      'Unable to establish redundant checked generations before deletion',
      { cause: error, possiblyCommitted: false },
    );
  }
  const prepared = await readCheckedFile(options);
  if (prepared.kind === 'missing') {
    throw new DurableFileError('DELETE_FAILED', 'Redundant checked generations disappeared', {
      possiblyCommitted: false,
    });
  }
  assertExpectedIdentity(prepared.payload, options.expectedIdentity);
  try {
    const currentBoundary = await validateSafeTarget(
      options.stateRoot,
      options.filePath,
      filesystem,
    );
    await assertBoundaryStable(currentBoundary, filesystem);
    const beforeCurrent = await readCheckedFile(options);
    if (beforeCurrent.kind === 'missing') {
      throw new DurableFileError('DELETE_FAILED', 'Checked deletion identity disappeared', {
        possiblyCommitted: false,
      });
    }
    assertExpectedIdentity(beforeCurrent.payload, options.expectedIdentity);
    const currentSerialized = serializeCheckedEnvelope(
      createCheckedEnvelope(options.schema, beforeCurrent.payload),
    );
    const currentDelete = await compareAndDelete(options.filePath, currentSerialized);
    if (currentDelete === 'mismatch') {
      throw new DurableFileError('DELETE_FAILED', 'Current generation changed before atomic deletion');
    }
    await assertBoundaryStable(currentBoundary, filesystem);
    if ((await syncDirectoryDurably(dirname(options.filePath), filesystem)) === 'unsupported') {
      directoryDurability = 'unsupported';
    }
  } catch (error) {
    throw new DurableFileError('DELETE_FAILED', 'Durable checked-file deletion failed', {
      cause: error,
      possiblyCommitted: false,
    });
  }

  const previousPath = `${options.filePath}.prev`;
  let previousBoundary: BoundarySnapshot;
  let previousPayload: T;
  try {
    previousBoundary = await validateSafeTarget(options.stateRoot, previousPath, filesystem);
    await assertBoundaryStable(previousBoundary, filesystem);
    const beforePrevious = await readCheckedFile(options);
    if (beforePrevious.kind === 'missing') {
      throw new DurableFileError('DELETE_FAILED', 'Final checked generation disappeared', {
        possiblyCommitted: false,
      });
    }
    assertExpectedIdentity(beforePrevious.payload, options.expectedIdentity);
    previousPayload = beforePrevious.payload;
  } catch (error) {
    throw new DurableFileError('DELETE_FAILED', 'Final checked generation is still preserved', {
      cause: error,
      possiblyCommitted: false,
    });
  }

  const previousSerialized = serializeCheckedEnvelope(
    createCheckedEnvelope(options.schema, previousPayload),
  );
  let previousDelete: 'deleted' | 'missing' | 'mismatch';
  try {
    previousDelete = await compareAndDelete(previousPath, previousSerialized);
  } catch (error) {
    // A native compare-delete may remove the final generation and then lose its
    // completion response. Observe the checked pair before deciding whether the
    // restore proof can be aborted and reused.
    try {
      const observed = await readCheckedFile(options);
      if (observed.kind === 'missing') {
        return {
          committed: true,
          possiblyDeleted: true,
          directoryDurability: 'unsupported',
          boundarySafety: filesystem.boundarySafety,
        };
      }
      try {
        assertExpectedIdentity(observed.payload, options.expectedIdentity);
      } catch {
        return {
          committed: true,
          possiblyDeleted: true,
          directoryDurability: 'unsupported',
          boundarySafety: filesystem.boundarySafety,
        };
      }
    } catch {
      return {
        committed: true,
        possiblyDeleted: true,
        directoryDurability: 'unsupported',
        boundarySafety: filesystem.boundarySafety,
      };
    }
    throw new DurableFileError('DELETE_FAILED', 'Final checked generation is still preserved', {
      cause: error,
      possiblyCommitted: false,
    });
  }
  if (previousDelete === 'mismatch') {
    throw new DurableFileError('DELETE_FAILED', 'Final checked generation changed before atomic deletion', {
      possiblyCommitted: false,
    });
  }

  try {
    await assertBoundaryStable(previousBoundary, filesystem);
    if ((await syncDirectoryDurably(dirname(previousPath), filesystem)) === 'unsupported') {
      directoryDurability = 'unsupported';
    }
  } catch {
    return {
      committed: true,
      possiblyDeleted: true,
      directoryDurability: 'unsupported',
      boundarySafety: filesystem.boundarySafety,
    };
  }
  return {
    committed: true,
    possiblyDeleted: false,
    directoryDurability,
    boundarySafety: filesystem.boundarySafety,
  };
}
