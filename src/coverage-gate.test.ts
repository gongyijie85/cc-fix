import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const checker = join(process.cwd(), 'scripts', 'check-critical-coverage.mjs');

async function fixture(
  branches: number[],
  windowsPath = false,
  includeDomain = true,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cc-fix-coverage-'));
  roots.push(root);
  const path = join(root, 'coverage.json');
  const sourcePath = windowsPath
    ? 'D:\\work\\cc-fix\\src\\state\\repository.ts'
    : '/work/cc-fix/src/state/repository.ts';
  const domainPath = windowsPath
    ? 'D:\\work\\cc-fix\\src\\domain\\region.ts'
    : '/work/cc-fix/src/domain/region.ts';
  await writeFile(path, JSON.stringify({
    [sourcePath]: { b: { 0: branches } },
    ...(includeDomain ? { [domainPath]: { b: { 0: [1] } } } : {}),
  }), 'utf8');
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('critical coverage checker', () => {
  it('fails independently for a real 89.x percent state aggregate', async () => {
    const path = await fixture([...Array(89).fill(1), ...Array(11).fill(0)]);
    const result = spawnSync(process.execPath, [checker, path], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('src/state: 89.00%');
  });

  it('passes a 90 percent aggregate and recognizes Windows backslash paths', async () => {
    const path = await fixture([...Array(90).fill(1), ...Array(10).fill(0)], true);
    const result = spawnSync(process.execPath, [checker, path], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('src/state: 90.00%');
  });

  it('fails when an existing critical source directory is absent from the report', async () => {
    const path = await fixture([...Array(100).fill(1)], false, false);
    const result = spawnSync(process.execPath, [checker, path], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('src/domain: FAIL no instrumented source files');
  });
});
