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
import { randomUUID } from 'node:crypto';
import {
  CheckedEnvelopeError,
  createCheckedEnvelope,
  decodeCheckedEnvelope,
  serializeCheckedEnvelope,
  type JsonValue,
} from './checksum.js';

export interface DurableFileHandle {
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface DurableFileStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface DurableFileSystem {
  open(path: string, flags: string): Promise<DurableFileHandle>;
  readFile(path: string): Promise<string>;
  lstat(path: string): Promise<DurableFileStat>;
  realpath(path: string): Promise<string>;
  /** Atomically replaces destination with a same-directory source when the platform supports it. */
  replace(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
  syncDirectory(directory: string): Promise<void>;
}

function asDurableHandle(handle: FileHandle): DurableFileHandle {
  return {
    writeFile: (data) => handle.writeFile(data, 'utf8').then(() => undefined),
    sync: () => handle.sync(),
    close: () => handle.close(),
  };
}

const unsupportedDirectorySyncCodes = new Set(['EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM']);

export const nodeDurableFileSystem: DurableFileSystem = {
  open: async (path, flags) => asDurableHandle(await open(path, flags)),
  readFile: (path) => readFile(path, 'utf8'),
  lstat,
  realpath,
  replace: rename,
  unlink,
  syncDirectory: async (directory) => {
    let handle: FileHandle | undefined;
    try {
      handle = await open(directory, 'r');
      await handle.sync();
    } catch (error) {
      if (
        process.platform === 'win32' &&
        isNodeError(error) &&
        unsupportedDirectorySyncCodes.has(error.code)
      ) {
        return;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  },
};

export type DurableFileErrorCode =
  | 'INVALID_PATH'
  | 'REPARSE_BOUNDARY'
  | 'CORRUPT'
  | 'BOTH_INVALID'
  | 'IO'
  | 'WRITE_FAILED';

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
}

export interface WriteCheckedFileOptions<T extends JsonValue> extends CheckedFileOptions {
  payload: T;
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

export interface GenerationFailure {
  kind: 'missing' | 'corrupt' | 'io';
  path: string;
  cause?: unknown;
}

type GenerationRead<T extends JsonValue> =
  | { kind: 'valid'; payload: T }
  | GenerationFailure;

function isNodeError(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]+/u).some((segment) => segment === '..');
}

function normalizedForComparison(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function isStrictDescendant(root: string, target: string): boolean {
  const normalizedRoot = normalizedForComparison(root);
  const normalizedTarget = normalizedForComparison(target);
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return normalizedTarget.startsWith(prefix);
}

async function validateSafeTarget(
  stateRoot: string,
  filePath: string,
  filesystem: DurableFileSystem,
): Promise<void> {
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
        if (
          normalizedForComparison(realCursor) !== normalizedForComparison(realRoot) &&
          !isStrictDescendant(realRoot, realCursor)
        ) {
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
  } catch (error) {
    if (error instanceof DurableFileError) throw error;
    throw new DurableFileError('IO', 'Unable to validate the state path boundary', { cause: error });
  }
}

async function readGeneration<T extends JsonValue>(
  path: string,
  schema: string,
  filesystem: DurableFileSystem,
  validatePayload?: (payload: JsonValue) => payload is T,
): Promise<GenerationRead<T>> {
  let serialized: string;
  try {
    serialized = await filesystem.readFile(path);
  } catch (error) {
    return isMissing(error)
      ? { kind: 'missing', path, cause: error }
      : { kind: 'io', path, cause: error };
  }

  try {
    const envelope = decodeCheckedEnvelope<T>(serialized, schema);
    if (validatePayload !== undefined && !validatePayload(envelope.payload)) {
      return { kind: 'corrupt', path, cause: new Error('Payload schema validation failed') };
    }
    return { kind: 'valid', payload: envelope.payload };
  } catch (error) {
    if (error instanceof CheckedEnvelopeError) {
      return { kind: 'corrupt', path, cause: error };
    }
    return { kind: 'io', path, cause: error };
  }
}

export async function readCheckedFile<T extends JsonValue = JsonValue>(
  options: ReadCheckedFileOptions<T>,
): Promise<CheckedFileReadResult<T>> {
  const filesystem = options.filesystem ?? nodeDurableFileSystem;
  await validateSafeTarget(options.stateRoot, options.filePath, filesystem);

  const current = await readGeneration(
    options.filePath,
    options.schema,
    filesystem,
    options.validatePayload,
  );
  if (current.kind === 'valid') {
    return { kind: 'ok', source: 'current', degraded: false, payload: current.payload };
  }

  const previousPath = `${options.filePath}.prev`;
  await validateSafeTarget(options.stateRoot, previousPath, filesystem);
  const previous = await readGeneration(
    previousPath,
    options.schema,
    filesystem,
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

async function removeOwnedTemp(path: string, filesystem: DurableFileSystem): Promise<void> {
  try {
    await filesystem.unlink(path);
  } catch (error) {
    if (!isMissing(error)) {
      // Cleanup is best effort; never delete any path other than this operation's exact temp.
    }
  }
}

async function prepareTemp(
  destination: string,
  serialized: string,
  filesystem: DurableFileSystem,
  ownedTemps: Set<string>,
): Promise<string> {
  const tempPath = `${destination}.cc-fix-tmp-${process.pid}-${randomUUID()}`;
  let handle: DurableFileHandle | undefined;
  try {
    handle = await filesystem.open(tempPath, 'wx');
    ownedTemps.add(tempPath);
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();
    handle = undefined;
    return tempPath;
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Preserve the operation error; exact-path cleanup follows in the outer finally.
    }
    throw error;
  }
}

export async function writeCheckedFile<T extends JsonValue>(
  options: WriteCheckedFileOptions<T>,
): Promise<void> {
  const filesystem = options.filesystem ?? nodeDurableFileSystem;
  await validateSafeTarget(options.stateRoot, options.filePath, filesystem);

  const ownedTemps = new Set<string>();
  let currentReplaced = false;
  try {
    const nextSerialized = serializeCheckedEnvelope(
      createCheckedEnvelope(options.schema, options.payload),
    );
    const nextTemp = await prepareTemp(
      options.filePath,
      nextSerialized,
      filesystem,
      ownedTemps,
    );

    const current = await readGeneration(options.filePath, options.schema, filesystem);
    if (current.kind === 'io') throw current.cause;
    if (current.kind === 'valid') {
      const previousPath = `${options.filePath}.prev`;
      const previousSerialized = serializeCheckedEnvelope(
        createCheckedEnvelope(options.schema, current.payload),
      );
      const previousTemp = await prepareTemp(
        previousPath,
        previousSerialized,
        filesystem,
        ownedTemps,
      );
      await validateSafeTarget(options.stateRoot, previousPath, filesystem);
      await filesystem.replace(previousTemp, previousPath);
      ownedTemps.delete(previousTemp);
      await filesystem.syncDirectory(dirname(previousPath));
    }

    await validateSafeTarget(options.stateRoot, options.filePath, filesystem);
    await filesystem.replace(nextTemp, options.filePath);
    ownedTemps.delete(nextTemp);
    currentReplaced = true;
    await filesystem.syncDirectory(dirname(options.filePath));
  } catch (error) {
    throw new DurableFileError('WRITE_FAILED', 'Durable checked-file write failed', {
      cause: error,
      possiblyCommitted: currentReplaced,
    });
  } finally {
    await Promise.all([...ownedTemps].map((path) => removeOwnedTemp(path, filesystem)));
  }
}
