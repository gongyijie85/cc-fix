import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFontFixService, type PrivilegedResult } from './service.js';
import { isSafeFontFileName } from './catalog.js';

describe('catalog whitelist', () => {
  it('accepts ttf/ttc names and rejects injection attempts', () => {
    expect(isSafeFontFileName('msyh.ttc')).toBe(true);
    expect(isSafeFontFileName('STKAITI.TTF')).toBe(true);
    expect(isSafeFontFileName('simsun.ttc')).toBe(true);
    expect(isSafeFontFileName('x; rm -rf.tff')).toBe(false);
    expect(isSafeFontFileName('..\\evil.ttc')).toBe(false);
    expect(isSafeFontFileName('a.ttf.exe')).toBe(false);
  });
});

describe('font fix service', () => {
  let root: string;
  let fontsDir: string;
  let calls: Array<Record<string, unknown>>;
  let nextResult: PrivilegedResult;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ccfix-fonts-'));
    fontsDir = join(root, 'Fonts');
    await mkdir(fontsDir, { recursive: true });
    await writeFile(join(fontsDir, 'msyh.ttc'), 'fake-yahei');
    await writeFile(join(fontsDir, 'simsun.ttc'), 'fake-simsun');
    await writeFile(join(fontsDir, 'arial.ttf'), 'not-chinese');
    calls = [];
    nextResult = { ok: true, pendingReboot: [] };
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const service = () => createFontFixService({
    stateRoot: join(root, 'state'),
    fontsDir,
    now: () => new Date('2026-08-15T00:00:00.000Z'),
    runner: async (request) => { calls.push({ ...request }); return nextResult; },
  });

  it('status finds pattern-matched fonts only and reports backup presence', async () => {
    const s = await service().status();
    expect(s.found).toEqual(['msyh.ttc', 'simsun.ttc']);
    expect(s.backedUp).toBe(false);
    await service().backup();
    const after = await service().status();
    expect(after.backedUp).toBe(true);
    expect(after.backupDir).toContain('font-backup');
  });

  it('backup copies files with a manifest and is idempotent', async () => {
    const dir1 = await service().backup();
    const dir2 = await service().backup();
    expect(dir2).toBe(dir1);
    const manifest = JSON.parse(await readFile(join(dir1, 'manifest.json'), 'utf8')) as Array<{ name: string; sha256: string }>;
    expect(manifest.map((m) => m.name).sort()).toEqual(['msyh.ttc', 'simsun.ttc']);
    const files = await readdir(join(dir1, 'fonts'));
    expect(files.sort()).toEqual(['msyh.ttc', 'simsun.ttc']);
  });

  it('remove backs up first, delegates to the privileged runner and persists pendingReboot', async () => {
    nextResult = { ok: true, pendingReboot: ['msyh.ttc'] };
    const result = await service().remove();
    expect(result).toEqual({ ok: true, pendingReboot: ['msyh.ttc'] });
    expect(calls[0]).toMatchObject({ mode: 'remove', fonts: ['msyh.ttc', 'simsun.ttc'] });
    const marker = JSON.parse(await readFile(join(root, 'state', 'font-remove-last.json'), 'utf8'));
    expect(marker.pendingReboot).toEqual(['msyh.ttc']);
    expect((await service().status()).pendingReboot).toEqual(['msyh.ttc']);
    expect((await service().status()).backedUp).toBe(true);
  });

  it('restore requires a backup and delegates with backupDir and regFile', async () => {
    await expect(service().restore()).resolves.toEqual({ ok: false, error: '字体备份不存在（或备份不完整）' });
    await service().backup();
    const result = await service().restore();
    expect(result).toEqual({ ok: true, pendingReboot: [] });
    expect(calls[0]).toMatchObject({ mode: 'restore' });
    expect(String(calls[0].backupDir)).toContain('fonts');
    expect(String(calls[0].regFile)).toContain('fonts-hklm.reg');
  });

  it('surfaces runner failures without persisting a marker', async () => {
    nextResult = { ok: false, error: '拒绝访问' };
    const result = await service().remove();
    expect(result).toEqual({ ok: false, error: '拒绝访问' });
    await expect(readFile(join(root, 'state', 'font-remove-last.json'), 'utf8')).rejects.toThrow();
  });

  it('ignores foreign or incomplete backup directories (issue #46 回归)', async () => {
    const foreign = join(root, 'state', 'font-backup', '20260809-101752');
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, 'system__msyh.ttc'), 'foreign');
    const dir = await service().backup();
    expect(dir).not.toBe(foreign);
    const files = await readdir(join(dir, 'fonts'));
    expect(files.sort()).toEqual(['msyh.ttc', 'simsun.ttc']);
    const s2 = createFontFixService({
      stateRoot: join(root, 'state2'),
      fontsDir,
      now: () => new Date('2026-08-15T00:00:00.000Z'),
      runner: async () => ({ ok: true, pendingReboot: [] }),
    });
    const foreign2 = join(root, 'state2', 'font-backup', '20260809-101752');
    await mkdir(foreign2, { recursive: true });
    await writeFile(join(foreign2, 'README.txt'), 'foreign');
    const result = await s2.restore();
    expect(result).toEqual({ ok: false, error: '字体备份不存在（或备份不完整）' });
    expect(calls).toHaveLength(0);
  });
});