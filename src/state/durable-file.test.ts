import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createCheckedEnvelope } from './checksum.js';
import {
  DurableFileError,
  type DurableFileSystem,
  nodeDurableFileSystem,
  readCheckedFile,
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
    syncDirectory: async (directory) => {
      hit('directorySync');
      await nodeDurableFileSystem.syncDirectory(directory);
    },
  };
}

describe('durable checked file writes', () => {
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
    await symlink(actualRoot, stateRoot, process.platform === 'win32' ? 'junction' : 'dir');

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
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');

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
    await symlink(
      outside,
      join(root, 'state.json.prev'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(readCheckedFile(options(root))).rejects.toMatchObject({
      code: 'REPARSE_BOUNDARY',
    });
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
