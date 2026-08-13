import { spawn } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import {
  createNativeCompareDeleteFileSystem,
} from './repository.js';
import { nodeDurableFileSystem, type DurableFileSystem } from './durable-file.js';

export type NativeHelperRunner = (
  helperPath: string,
  root: string,
  fileName: string,
  expectedContents: string,
) => Promise<'deleted' | 'missing' | 'mismatch'>;

export const runNativeCompareDeleteHelper: NativeHelperRunner = (
  helperPath,
  root,
  fileName,
  expectedContents,
) => new Promise((resolveResult, reject) => {
  const child = spawn(helperPath, ['compare-delete', root, fileName], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => {
    const result = stdout.trim();
    if (code === 0 && (result === 'deleted' || result === 'missing' || result === 'mismatch')) {
      resolveResult(result);
      return;
    }
    reject(new Error(`Native compare-delete helper failed (${code ?? 'signal'}): ${stderr.trim()}`));
  });
  child.stdin.end(expectedContents, 'utf8');
});

export function createNativeHelperFileSystem(options: {
  root: string;
  helperPath: string;
  runner?: NativeHelperRunner;
}): DurableFileSystem {
  const root = resolve(options.root);
  const runner = options.runner ?? runNativeCompareDeleteHelper;
  const allowed = new Set(['persist-backup.json', 'persist-backup.json.prev']);
  return createNativeCompareDeleteFileSystem({
    ...nodeDurableFileSystem,
    compareDeleteCapability: 'native-compare-delete',
    compareAndDelete: async (path, expectedContents) => {
      const absolute = resolve(path);
      const fileName = basename(absolute);
      if (resolve(dirname(absolute)) !== root || !allowed.has(fileName)) {
        throw new Error('Native compare-delete target is outside the fixed backup scope');
      }
      return runner(options.helperPath, root, fileName, expectedContents);
    },
  });
}
