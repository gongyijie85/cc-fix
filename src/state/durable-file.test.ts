import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createJunctionWithRetry } from '../test-support/junction.js';
import { createCheckedEnvelope } from './checksum.js';
import {
  DurableFileError,
  type DurableFileSystem,
  nodeDurableFileSystem,
  readCheckedFile,
  validateWindowsLiteralPathSyntax,
  writeCheckedFile,
} from './durable-file.js';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cc-fix-durable-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const options = (root: string, filesystem?: DurableFileSystem) => ({
  stateRoot: root,
  filePath: join(root, 'state.json'),
  schema: 'test-state-v1',
  filesystem,
});

function isRevisionPayload(payload: unknown): payload is { revision: number } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    typeof (payload as { revision?: unknown }).revision === 'number'
  );
}

describe('durable checked file reads', () => {
  it('reports a missing file distinctly from corruption', async () => {
    const root = await makeRoot();

    await expect(readCheckedFile(options(root))).resolves.toEqual({ kind: 'missing' });
  });

  it('reads a valid current generation', async () => {
    const root = await makeRoot();
    await writeCheckedFile({ ...options(root), payload: { revision: 1 } });

    await expect(readCheckedFile(options(root))).resolves.toMatchObject({
      kind: 'ok',
      source: 'current',
      payload: { revision: 1 },
    });
  });

  it('keeps two valid generations after two successful writes', async () => {
    const root = await makeRoot();
    await writeCheckedFile({ ...options(root), payload: { revision: 1 } });
    await writeCheckedFile({ ...options(root), payload: { revision: 2 } });

    await expect(readCheckedFile(options(root))).resolves.toMatchObject({
      source: 'current',
      payload: { revision: 2 },
    });
    await expect(
      readCheckedFile({ ...options(root), filePath: join(root, 'state.json.prev') }),
    ).resolves.toMatchObject({ source: 'current', payload: { revision: 1 } });
  });

  it('replaces an existing predecessor with the immediately prior valid generation', async () => {
    const root = await makeRoot();
    await writeCheckedFile({ ...options(root), payload: { revision: 1 } });
    await writeCheckedFile({ ...options(root), payload: { revision: 2 } });
    await writeCheckedFile({ ...options(root), payload: { revision: 3 } });

    await expect(
      readCheckedFile({ ...options(root), filePath: join(root, 'state.json.prev') }),
    ).resolves.toMatchObject({ source: 'current', payload: { revision: 2 } });
  });

  it('recovers only a validated predecessor when current is corrupt', async () => {
    const root = await makeRoot();
    await writeCheckedFile({ ...options(root), payload: { revision: 1 } });
    await writeCheckedFile({ ...options(root), payload: { revision: 2 } });
    await writeFile(join(root, 'state.json'), '{"partial":', 'utf8');

    await expect(readCheckedFile(options(root))).resolves.toMatchObject({
      kind: 'ok',
      source: 'previous',
      degraded: true,
      payload: { revision: 1 },
      currentFailure: { kind: 'corrupt' },
    });
  });

  it('rejects a corrupt current when no valid predecessor exists', async () => {
    const root = await makeRoot();
    await writeFile(join(root, 'state.json'), 'not-json', 'utf8');

    await expect(readCheckedFile(options(root))).rejects.toMatchObject({
      code: 'CORRUPT',
    });
  });

  it('reports both generations invalid instead of silently recovering', async () => {
    const root = await makeRoot();
    await writeFile(join(root, 'state.json'), 'not-json', 'utf8');
    await writeFile(join(root, 'state.json.prev'), '{}', 'utf8');

    await expect(readCheckedFile(options(root))).rejects.toMatchObject({
      code: 'BOTH_INVALID',
    });
  });

  it('treats a checksummed payload that fails its supplied schema validator as corrupt', async () => {
    const root = await makeRoot();
    const envelope = createCheckedEnvelope('test-state-v1', { revision: 'wrong-type' });
    await writeFile(join(root, 'state.json'), JSON.stringify(envelope), 'utf8');

    await expect(
      readCheckedFile({
        ...options(root),
        validatePayload: (payload): payload is { revision: number } =>
          typeof payload === 'object' &&
          payload !== null &&
          !Array.isArray(payload) &&
          typeof payload.revision === 'number',
      }),
    ).rejects.toMatchObject({ code: 'CORRUPT' });
  });

  it('treats a throwing read validator as corruption rather than an I/O failure', async () => {
    const root = await makeRoot();
    await writeCheckedFile({ ...options(root), payload: { revision: 1 } });

    await expect(
      readCheckedFile({
        ...options(root),
        validatePayload: (): never => {
          throw new Error('validator bug');
        },
      }),
    ).rejects.toMatchObject({ code: 'CORRUPT' });
  });

  it('classifies a non-missing filesystem read failure as IO', async () => {
    const root = await makeRoot();
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      readFile: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    };

    await expect(readCheckedFile(options(root, filesystem))).rejects.toMatchObject({ code: 'IO' });
  });
});

type FaultOperation = 'open' | 'write' | 'fileSync' | 'replace' | 'directorySync';

function faultFilesystem(operation: FaultOperation, occurrence = 1): DurableFileSystem {
  const counts = new Map<FaultOperation, number>();
  const hit = (candidate: FaultOperation): void => {
    if (candidate !== operation) return;
    const count = (counts.get(candidate) ?? 0) + 1;
    counts.set(candidate, count);
    if (count === occurrence) {
      throw Object.assign(new Error(`injected ${candidate} failure`), { code: 'EIO' });
    }
  };

  return {
    ...nodeDurableFileSystem,
    open: async (path, flags) => {
      hit('open');
      const handle = await nodeDurableFileSystem.open(path, flags);
      return {
        writeFile: async (data) => {
          hit('write');
          await handle.writeFile(data);
        },
        sync: async () => {
          hit('fileSync');
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
    replace: async (source, destination) => {
      hit('replace');
      await nodeDurableFileSystem.replace(source, destination);
    },
    openDirectory: async (directory) => {
      const handle = await nodeDurableFileSystem.openDirectory(directory);
      return {
        sync: async () => {
          hit('directorySync');
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
  };
}

describe('durable checked file writes', () => {
  it('reads a successful complex write back immediately with the same payload', async () => {
    const root = await makeRoot();
    const payload = { revision: 1, nested: { regions: ['us', 'eu'], enabled: true } };

    await writeCheckedFile({ ...options(root), payload });

    await expect(readCheckedFile(options(root))).resolves.toMatchObject({ payload });
  });

  it('uses precise bigint identities from the Node filesystem adapter', async () => {
    const root = await makeRoot();
    const stat = await nodeDurableFileSystem.lstat(root);

    expect(typeof stat.dev).toBe('bigint');
    expect(typeof stat.ino).toBe('bigint');
  });
  it('rejects a schema-invalid new payload before opening a temporary file', async () => {
    const root = await makeRoot();
    let openCalls = 0;
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      open: async (path, flags) => {
        openCalls += 1;
        return nodeDurableFileSystem.open(path, flags);
      },
    };

    await expect(
      writeCheckedFile({
        ...options(root, filesystem),
        payload: { revision: 'invalid' },
        validatePayload: isRevisionPayload,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(openCalls).toBe(0);
  });

  it('wraps a throwing write validator as INVALID_PAYLOAD before any temp open', async () => {
    const root = await makeRoot();
    let openCalls = 0;
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      open: async (path, flags) => {
        openCalls += 1;
        return nodeDurableFileSystem.open(path, flags);
      },
    };

    await expect(
      writeCheckedFile({
        ...options(root, filesystem),
        payload: { revision: 1 },
        validatePayload: () => {
          throw new Error('validator bug');
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(openCalls).toBe(0);
  });

  it('does not rotate a schema-invalid current over the last valid predecessor', async () => {
    const root = await makeRoot();
    await writeCheckedFile({
      ...options(root),
      payload: { revision: 1 },
      validatePayload: isRevisionPayload,
    });
    await writeCheckedFile({
      ...options(root),
      payload: { revision: 2 },
      validatePayload: isRevisionPayload,
    });
    await writeFile(
      join(root, 'state.json'),
      JSON.stringify(createCheckedEnvelope('test-state-v1', { revision: 'invalid' })),
      'utf8',
    );

    await writeCheckedFile({
      ...options(root),
      payload: { revision: 3 },
      validatePayload: isRevisionPayload,
    });

    await expect(
      readCheckedFile({
        ...options(root),
        filePath: join(root, 'state.json.prev'),
        validatePayload: isRevisionPayload,
      }),
    ).resolves.toMatchObject({ payload: { revision: 1 } });
  });

  it.each<FaultOperation>(['open', 'write', 'fileSync', 'replace', 'directorySync'])(
    'leaves no invalid generation when the first write fails at %s',
    async (operation) => {
      const root = await makeRoot();

      await expect(
        writeCheckedFile({
          ...options(root, faultFilesystem(operation)),
          payload: { revision: 1 },
        }),
      ).rejects.toMatchObject<Partial<DurableFileError>>({ code: 'WRITE_FAILED' });
      const result = await readCheckedFile(options(root));
      expect(result.kind === 'missing' || result.kind === 'ok').toBe(true);
    },
  );

  it('marks a final directory-sync failure as possibly committed', async () => {
    const root = await makeRoot();
    await writeCheckedFile({ ...options(root), payload: { revision: 1 } });

    await expect(
      writeCheckedFile({
        ...options(root, faultFilesystem('directorySync', 2)),
        payload: { revision: 2 },
      }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', possiblyCommitted: true });
    await expect(readCheckedFile(options(root))).resolves.toMatchObject({
      payload: { revision: 2 },
    });
    await expect(
      readCheckedFile({ ...options(root), filePath: join(root, 'state.json.prev') }),
    ).resolves.toMatchObject({ payload: { revision: 1 } });
  });

  it('reports unsupported directory durability instead of claiming a full durable write', async () => {
    const root = await makeRoot();
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      directorySyncCapability: 'unsupported',
    };

    await expect(
      writeCheckedFile({ ...options(root, filesystem), payload: { revision: 1 } }),
    ).resolves.toMatchObject({
      directoryDurability: 'unsupported',
      boundarySafety: 'identity-checked',
    });
  });

  it('does not downgrade a directory open failure to unsupported', async () => {
    const root = await makeRoot();
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      openDirectory: async () => {
        throw Object.assign(new Error('directory open denied'), { code: 'EACCES' });
      },
    };

    await expect(
      writeCheckedFile({ ...options(root, filesystem), payload: { revision: 1 } }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', possiblyCommitted: true });
  });

  it('does not swallow a directory close failure', async () => {
    const root = await makeRoot();
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      openDirectory: async (directory) => {
        const handle = await nodeDurableFileSystem.openDirectory(directory);
        return {
          sync: () => handle.sync(),
          close: async () => {
            await handle.close();
            throw Object.assign(new Error('directory close failed'), { code: 'EIO' });
          },
        };
      },
    };

    await expect(
      writeCheckedFile({ ...options(root, filesystem), payload: { revision: 1 } }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', possiblyCommitted: true });
  });

  it('does not downgrade an unsupported-looking sync error in supported mode', async () => {
    const root = await makeRoot();
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      directorySyncCapability: 'supported',
      openDirectory: async () => ({
        sync: async () => {
          throw Object.assign(new Error('unexpected EINVAL'), { code: 'EINVAL' });
        },
        close: async () => undefined,
      }),
    };

    await expect(
      writeCheckedFile({ ...options(root, filesystem), payload: { revision: 1 } }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', possiblyCommitted: true });
  });

  it('does not treat EBADF as an unsupported directory-sync probe result', async () => {
    const root = await makeRoot();
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      directorySyncCapability: 'probe',
      openDirectory: async () => ({
        sync: async () => {
          throw Object.assign(new Error('bad directory handle'), { code: 'EBADF' });
        },
        close: async () => undefined,
      }),
    };

    await expect(
      writeCheckedFile({ ...options(root, filesystem), payload: { revision: 1 } }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', possiblyCommitted: true });
  });

  it('reports a recognized directory-sync capability probe as unsupported', async () => {
    const root = await makeRoot();
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      directorySyncCapability: 'probe',
      openDirectory: async () => ({
        sync: async () => {
          throw Object.assign(new Error('directory sync unsupported'), { code: 'EINVAL' });
        },
        close: async () => undefined,
      }),
    };

    await expect(
      writeCheckedFile({ ...options(root, filesystem), payload: { revision: 1 } }),
    ).resolves.toMatchObject({ directoryDurability: 'unsupported' });
  });

  it('preserves both directory sync and close failures', async () => {
    const root = await makeRoot();
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      directorySyncCapability: 'supported',
      openDirectory: async () => ({
        sync: async () => {
          throw new Error('directory sync failed');
        },
        close: async () => {
          throw new Error('directory close failed');
        },
      }),
    };

    await expect(
      writeCheckedFile({ ...options(root, filesystem), payload: { revision: 1 } }),
    ).rejects.toMatchObject({
      code: 'WRITE_FAILED',
      possiblyCommitted: true,
      cause: expect.any(AggregateError),
    });
  });

  it('conservatively reports possibly committed when replace succeeds and then throws', async () => {
    const root = await makeRoot();
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      replace: async (source, destination) => {
        await nodeDurableFileSystem.replace(source, destination);
        throw Object.assign(new Error('post-commit replace failure'), { code: 'EIO' });
      },
    };

    await expect(
      writeCheckedFile({ ...options(root, filesystem), payload: { revision: 1 } }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', possiblyCommitted: true });
    await expect(readCheckedFile(options(root))).resolves.toMatchObject({
      payload: { revision: 1 },
    });
  });

  it('removes its partial temp after a partial write failure without changing current', async () => {
    const root = await makeRoot();
    await writeCheckedFile({ ...options(root), payload: { revision: 1 } });
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      open: async (path, flags) => {
        const handle = await nodeDurableFileSystem.open(path, flags);
        return {
          ...handle,
          writeFile: async (data) => {
            await handle.writeFile(data.slice(0, 8));
            throw Object.assign(new Error('partial write'), { code: 'EIO' });
          },
        };
      },
    };

    await expect(
      writeCheckedFile({ ...options(root, filesystem), payload: { revision: 2 } }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', possiblyCommitted: false });
    await expect(readCheckedFile(options(root))).resolves.toMatchObject({
      payload: { revision: 1 },
    });
    expect((await readdir(root)).filter((name) => name.includes('.cc-fix-tmp-'))).toEqual([]);
  });

  it('preserves both the primary operation error and a close error', async () => {
    const root = await makeRoot();
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      open: async (path, flags) => {
        const handle = await nodeDurableFileSystem.open(path, flags);
        return {
          ...handle,
          writeFile: async () => {
            throw new Error('primary write failure');
          },
          close: async () => {
            await handle.close();
            throw new Error('secondary close failure');
          },
        };
      },
    };

    await expect(
      writeCheckedFile({ ...options(root, filesystem), payload: { revision: 1 } }),
    ).rejects.toMatchObject({
      code: 'WRITE_FAILED',
      cause: expect.any(AggregateError),
    });
  });

  it('fails closed when the root identity changes between validation and temp open', async () => {
    const root = await makeRoot();
    let identityChanged = false;
    let replaceCalls = 0;
    let unlinkCalls = 0;
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      lstat: async (path) => {
        const stat = await nodeDurableFileSystem.lstat(path);
        if (identityChanged && resolve(path) === resolve(root)) {
          return {
            isDirectory: () => stat.isDirectory(),
            isSymbolicLink: () => stat.isSymbolicLink(),
            dev: stat.dev,
            ino: BigInt(stat.ino ?? 0) + 1n,
          };
        }
        return stat;
      },
      open: async (path, flags) => {
        const handle = await nodeDurableFileSystem.open(path, flags);
        identityChanged = true;
        return handle;
      },
      replace: async (source, destination) => {
        replaceCalls += 1;
        await nodeDurableFileSystem.replace(source, destination);
      },
      unlink: async (path) => {
        unlinkCalls += 1;
        await nodeDurableFileSystem.unlink(path);
      },
    };

    await expect(
      writeCheckedFile({ ...options(root, filesystem), payload: { revision: 1 } }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', possiblyCommitted: false });
    expect(replaceCalls).toBe(0);
    expect(unlinkCalls).toBe(0);
  });

  it('detects adjacent bigint identities above the safe integer range', async () => {
    const root = await makeRoot();
    let identityChanged = false;
    let replaceCalls = 0;
    const firstIdentity = 9_007_199_254_740_992n;
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      lstat: async (path) => {
        const stat = await nodeDurableFileSystem.lstat(path);
        if (resolve(path) === resolve(root)) {
          return {
            isDirectory: () => stat.isDirectory(),
            isSymbolicLink: () => stat.isSymbolicLink(),
            dev: 1n,
            ino: identityChanged ? firstIdentity + 1n : firstIdentity,
          };
        }
        return stat;
      },
      open: async (path, flags) => {
        const handle = await nodeDurableFileSystem.open(path, flags);
        identityChanged = true;
        return handle;
      },
      replace: async (source, destination) => {
        replaceCalls += 1;
        await nodeDurableFileSystem.replace(source, destination);
      },
    };

    await expect(
      writeCheckedFile({ ...options(root, filesystem), payload: { revision: 1 } }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', possiblyCommitted: false });
    expect(replaceCalls).toBe(0);
  });

  it('fails closed when native no-follow safety is required from the Node adapter', async () => {
    const root = await makeRoot();

    await expect(
      writeCheckedFile({
        ...options(root),
        payload: { revision: 1 },
        requiredBoundarySafety: 'native-no-follow',
      }),
    ).rejects.toMatchObject({ code: 'BOUNDARY_UNSUPPORTED' });
  });

  it.each([
    ['open', 1],
    ['write', 1],
    ['fileSync', 1],
    ['open', 2],
    ['write', 2],
    ['fileSync', 2],
    ['replace', 1],
    ['directorySync', 1],
    ['replace', 2],
    ['directorySync', 2],
  ] as const)(
    'preserves a readable valid generation when second write fails at %s #%i',
    async (operation, occurrence) => {
      const root = await makeRoot();
      await writeCheckedFile({ ...options(root), payload: { revision: 1 } });

      await expect(
        writeCheckedFile({
          ...options(root, faultFilesystem(operation, occurrence)),
          payload: { revision: 2 },
        }),
      ).rejects.toMatchObject({ code: 'WRITE_FAILED' });

      const current = await readCheckedFile(options(root));
      expect(current).toMatchObject({ kind: 'ok' });
      if (current.kind === 'ok' && current.payload.revision !== 1) {
        await expect(
          readCheckedFile({ ...options(root), filePath: join(root, 'state.json.prev') }),
        ).resolves.toMatchObject({ kind: 'ok', payload: { revision: 1 } });
      }
    },
  );

  it('cleans only a temporary file created by the failed operation', async () => {
    const root = await makeRoot();
    const unrelated = join(root, 'state.json.tmp-user-evidence');
    await writeFile(unrelated, 'keep', 'utf8');

    await expect(
      writeCheckedFile({
        ...options(root, faultFilesystem('write')),
        payload: { revision: 1 },
      }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED' });

    expect(await readFile(unrelated, 'utf8')).toBe('keep');
    expect((await readdir(root)).filter((name) => name.includes('.cc-fix-tmp-'))).toEqual([]);
  });
});

describe('durable checked file path confinement', () => {
  it.each([
    '\\\\?\\C:\\state\\state.json',
    '\\\\.\\C:\\state\\state.json',
    '\\\\server\\share\\state.json',
    'C:\\state\\state.json:stream',
    'C:\\state\\trailing.\\state.json',
    'C:\\state\\trailing \\state.json',
    'C:\\state\\\\state.json',
    'C:\\state\\.\\state.json',
    'C:\\state\\CON.json',
    'C:\\state\\LPT1',
    'C:\\state\\CONOUT$',
    'C:\\state\\bad?name\\state.json',
  ])('rejects unsafe Windows literal path syntax: %s', (path) => {
    expect(() => validateWindowsLiteralPathSyntax(path)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PATH' }),
    );
  });

  it('accepts a literal local-drive Windows state path with either separator', () => {
    expect(() =>
      validateWindowsLiteralPathSyntax('C:\\Users\\Person\\AppData\\Roaming\\cc-fix\\state.json'),
    ).not.toThrow();
    expect(() =>
      validateWindowsLiteralPathSyntax('C:/Users/Person/AppData/Roaming/cc-fix/state.json'),
    ).not.toThrow();
  });

  it.each([
    ['relative root', 'state-root', resolve('state-root', 'state.json')],
    ['relative target', resolve('state-root'), 'state.json'],
    ['root itself', resolve('state-root'), resolve('state-root')],
    [
      'dot-dot segment',
      resolve('state-root'),
      `${resolve('state-root')}\\nested\\..\\state.json`,
    ],
    ['outside root', resolve('state-root'), resolve('state.json')],
    ['prefix sibling', resolve('state-root'), resolve('state-root-sibling', 'state.json')],
  ])('rejects %s before reading or writing', async (_name, stateRoot, filePath) => {
    await expect(
      readCheckedFile({ stateRoot, filePath, schema: 'test-state-v1' }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('rejects a supplied state root that is not a directory', async () => {
    const container = await makeRoot();
    const stateRoot = join(container, 'not-a-directory');
    await writeFile(stateRoot, 'file', 'utf8');

    await expect(
      readCheckedFile({
        stateRoot,
        filePath: join(stateRoot, 'state.json'),
        schema: 'test-state-v1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('rejects a supplied state root that is itself a reparse point', async () => {
    const container = await makeRoot();
    const actualRoot = await makeRoot();
    const stateRoot = join(container, 'linked-root');
    await createJunctionWithRetry(actualRoot, stateRoot);

    await expect(
      readCheckedFile({
        stateRoot,
        filePath: join(stateRoot, 'state.json'),
        schema: 'test-state-v1',
      }),
    ).rejects.toMatchObject({ code: 'REPARSE_BOUNDARY' });
  });

  it('rejects an existing reparse boundary that leaves the real state root', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const linked = join(root, 'linked');
    await mkdir(outside, { recursive: true });
    await createJunctionWithRetry(outside, linked);

    await expect(
      writeCheckedFile({
        stateRoot: root,
        filePath: join(linked, 'state.json'),
        schema: 'test-state-v1',
        payload: { revision: 1 },
      }),
    ).rejects.toMatchObject({ code: 'REPARSE_BOUNDARY' });
  });

  it('does not follow a predecessor reparse point outside the state root', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await createJunctionWithRetry(outside, join(root, 'state.json.prev'));

    await expect(readCheckedFile(options(root))).rejects.toMatchObject({
      code: 'REPARSE_BOUNDARY',
    });
  });

  it('fails closed when boundary identity changes during a missing-file read', async () => {
    const root = await makeRoot();
    let identityChanged = false;
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      lstat: async (path) => {
        const stat = await nodeDurableFileSystem.lstat(path);
        if (identityChanged && resolve(path) === resolve(root)) {
          return {
            isDirectory: () => stat.isDirectory(),
            isSymbolicLink: () => stat.isSymbolicLink(),
            dev: stat.dev,
            ino: BigInt(stat.ino ?? 0) + 1n,
          };
        }
        return stat;
      },
      readFile: async (path) => {
        identityChanged = true;
        return nodeDurableFileSystem.readFile(path);
      },
    };

    await expect(readCheckedFile(options(root, filesystem))).rejects.toMatchObject({
      code: 'REPARSE_BOUNDARY',
    });
  });

  it('rejects a case-only realpath alias when it resolves to a different identity', async () => {
    const root = await makeRoot();
    const filePath = join(root, 'state.json');
    await writeCheckedFile({ ...options(root), payload: { revision: 1 } });
    const realRoot = await nodeDurableFileSystem.realpath(root);
    const caseOnlyAlias = realRoot.toUpperCase();
    let replaceCalls = 0;
    const filesystem: DurableFileSystem = {
      ...nodeDurableFileSystem,
      realpath: async (path) =>
        resolve(path) === resolve(filePath)
          ? caseOnlyAlias
          : nodeDurableFileSystem.realpath(path),
      replace: async (source, destination) => {
        replaceCalls += 1;
        await nodeDurableFileSystem.replace(source, destination);
      },
    };

    await expect(
      writeCheckedFile({ ...options(root, filesystem), payload: { revision: 2 } }),
    ).rejects.toMatchObject({ code: 'REPARSE_BOUNDARY' });
    expect(replaceCalls).toBe(0);
  });

  it('accepts an ordinary nested absolute path inside the supplied root', async () => {
    const root = await makeRoot();
    const nested = join(root, 'nested');
    await mkdir(nested);
    const filePath = join(nested, 'state.json');

    await writeCheckedFile({
      stateRoot: root,
      filePath,
      schema: 'test-state-v1',
      payload: { revision: 1 },
    });

    await expect(
      readCheckedFile({ stateRoot: root, filePath, schema: 'test-state-v1' }),
    ).resolves.toMatchObject({ payload: { revision: 1 } });
  });
});
