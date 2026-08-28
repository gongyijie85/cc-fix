import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFontFixService, parseRegFileToEntries, validatePrivilegedRequest, type FontRegistryEntries, type PrivilegedResult } from './service.js';
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

describe('privileged request validation (issue #49)', () => {
  const anchor = 'C:\\Users\\u\\AppData\\Roaming\\cc-fix\\font-backup';
  it('accepts anchored restore requests and plain remove requests', () => {
    expect(validatePrivilegedRequest({ mode: 'remove', expectedNames: ['msyh.ttc'] }, anchor)).toBeNull();
    expect(validatePrivilegedRequest({
      mode: 'restore',
      backupDir: `${anchor}\\2026-08-15T00-00-00-000Z\\fonts`,
      regJsonPath: `${anchor}\\2026-08-15T00-00-00-000Z\\fonts-hklm.json`,
    }, anchor)).toBeNull();
  });
  it('rejects paths escaping the anchor, traversal and unexpected json names', () => {
    expect(validatePrivilegedRequest({ mode: 'restore', backupDir: 'C:\\Windows\\Fonts' }, anchor)).toContain('escapes');
    expect(validatePrivilegedRequest({ mode: 'restore', backupDir: `${anchor}\\..\\..\\evil` }, anchor)).toContain('escapes');
    expect(validatePrivilegedRequest({ mode: 'restore', backupDir: `${anchor}\\x\\fonts`, regJsonPath: `${anchor}\\x\\evil.reg` }, anchor)).toContain('unexpected registry json name');
    expect(validatePrivilegedRequest({ mode: 'restore', backupDir: `${anchor}\\x\\fonts`, regJsonPath: 'C:\\evil\\fonts-hklm.json' }, anchor)).toContain('escapes');
    expect(validatePrivilegedRequest({ mode: 'remove', expectedNames: [] }, anchor)).toContain('empty');
    expect(validatePrivilegedRequest({ mode: 'remove', expectedNames: ['..\\evil.ttc'] }, anchor)).toContain('invalid');
    expect(validatePrivilegedRequest({ mode: 'destroy' }, anchor)).toContain('unknown mode');
  });
});

describe('legacy reg export parsing (issue #49 兼容)', () => {
  it('parses REGEDIT5 string values with escapes and ignores non-Fonts sections', () => {
    const text = [
      'Windows Registry Editor Version 5.00',
      '',
      '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Evil]',
      '"Persist (TrueType)"="evil.ttf"',
      '',
      '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts]',
      '"A \\"quoted\\" Name (TrueType)"="a.ttf"',
      '"YaHei (TrueType)"="msyh.ttc"',
      '"Path (TrueType)"="C:\\\\Windows\\\\Fonts\\\\simsun.ttc"',
      '"HexValue"=hex:01,02',
      '',
    ].join('\r\n');
    expect(parseRegFileToEntries(text)).toEqual({
      'A "quoted" Name (TrueType)': 'a.ttf',
      'YaHei (TrueType)': 'msyh.ttc',
      'Path (TrueType)': 'C:\\Windows\\Fonts\\simsun.ttc',
    });
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
    nextResult = { ok: true, pendingReboot: [], scheduledDeleteNames: [] };
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const registryFixture: FontRegistryEntries = {
    'Microsoft YaHei & Microsoft YaHei UI (TrueType)': 'msyh.ttc',
    '宋体 (TrueType)': 'C:\\Windows\\Fonts\\simsun.ttc',
    'Arial (TrueType)': 'arial.ttf',
    'Segoe UI (TrueType)': 'segoeui.ttf',
  };

  const service = () => createFontFixService({
    stateRoot: join(root, 'state'),
    fontsDir,
    now: () => new Date('2026-08-15T00:00:00.000Z'),
    runner: async (request) => { calls.push({ ...request }); return nextResult; },
    readFontRegistrations: async () => registryFixture,
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
    // 注册表备份只保留中文字体相关项（裸文件名与绝对路径两种数据形态）
    const registry = JSON.parse(await readFile(join(dir1, 'fonts-hklm.json'), 'utf8')) as { entries: FontRegistryEntries };
    expect(Object.keys(registry.entries).sort()).toEqual(['Microsoft YaHei & Microsoft YaHei UI (TrueType)', '宋体 (TrueType)']);
  });

  it('remove backs up first, delegates to the privileged runner and persists pendingReboot', async () => {
    nextResult = { ok: true, pendingReboot: ['msyh.ttc'], scheduledDeleteNames: ['msyh.ttc'] };
    const result = await service().remove();
    expect(result).toEqual({ ok: true, pendingReboot: ['msyh.ttc'], scheduledDeleteNames: ['msyh.ttc'] });
    // 删除清单与刚完成并验证的备份绑定；提权端还会重新枚举并要求精确相等。
    expect(calls[0]).toEqual({ mode: 'remove', expectedNames: ['msyh.ttc', 'simsun.ttc'] });
    const marker = JSON.parse(await readFile(join(root, 'state', 'font-remove-last.json'), 'utf8'));
    expect(marker.pendingReboot).toEqual(['msyh.ttc']);
    expect((await service().status()).pendingReboot).toEqual(['msyh.ttc']);
    expect((await service().status()).backedUp).toBe(true);
  });

  it('refuses removal when every matched font cannot be copied into the backup', async () => {
    await rm(join(fontsDir, 'simsun.ttc'));
    await mkdir(join(fontsDir, 'simsun.ttc'));

    const result = await service().remove();

    expect(result).toEqual({ ok: false, error: '字体备份不完整：无法备份 simsun.ttc' });
    expect(calls).toHaveLength(0);
  });

  it('refuses removal when the font registry cannot be backed up', async () => {
    const guarded = createFontFixService({
      stateRoot: join(root, 'state'),
      fontsDir,
      now: () => new Date('2026-08-15T00:00:00.000Z'),
      runner: async (request) => { calls.push({ ...request }); return nextResult; },
      readFontRegistrations: async () => { throw new Error('registry unavailable'); },
    });

    const result = await guarded.remove();

    expect(result).toEqual({ ok: false, error: '字体备份不完整：无法读取字体注册表' });
    expect(calls).toHaveLength(0);
  });

  it('creates a fresh backup for removal instead of reusing stale font bytes', async () => {
    let instant = new Date('2026-08-15T00:00:00.000Z');
    const guarded = createFontFixService({
      stateRoot: join(root, 'state'),
      fontsDir,
      now: () => instant,
      runner: async (request) => { calls.push({ ...request }); return nextResult; },
      readFontRegistrations: async () => registryFixture,
    });
    await guarded.backup();
    await writeFile(join(fontsDir, 'msyh.ttc'), 'updated-yahei');
    instant = new Date('2026-08-16T00:00:00.000Z');

    await guarded.remove();

    const backupRoot = join(root, 'state', 'font-backup');
    const backups = (await readdir(backupRoot)).sort();
    expect(backups).toHaveLength(2);
    expect(await readFile(join(backupRoot, backups[1]!, 'fonts', 'msyh.ttc'), 'utf8')).toBe('updated-yahei');
  });

  it('never reuses or overwrites a backup directory when timestamps collide', async () => {
    const guarded = service();
    const first = await guarded.backup();
    const original = await readFile(join(first, 'fonts', 'msyh.ttc'), 'utf8');

    await guarded.remove();

    const backups = await readdir(join(root, 'state', 'font-backup'));
    expect(backups).toHaveLength(2);
    expect(await readFile(join(first, 'fonts', 'msyh.ttc'), 'utf8')).toBe(original);
  });

  it('restore requires a backup and delegates with anchored backupDir and registry json', async () => {
    await expect(service().restore()).resolves.toEqual({ ok: false, error: '字体备份不存在（或备份不完整）' });
    const dir = await service().backup();
    const result = await service().restore();
    expect(result).toEqual({ ok: true, pendingReboot: [], scheduledDeleteNames: [] });
    expect(calls[0]).toMatchObject({ mode: 'restore' });
    expect(String(calls[0].backupDir)).toBe(join(dir, 'fonts'));
    expect(String(calls[0].regJsonPath)).toBe(join(dir, 'fonts-hklm.json'));
  });

  it('binds restore to the font deletions previously scheduled for reboot', async () => {
    await service().backup();
    await mkdir(join(root, 'state'), { recursive: true });
    await writeFile(join(root, 'state', 'font-remove-last.json'), JSON.stringify({ pendingReboot: ['msyh.ttc'] }));

    await service().restore();

    expect(calls[0]).toMatchObject({ mode: 'restore', scheduledDeleteNames: ['msyh.ttc'] });
  });

  it('cancels only reboot deletions that the latest remove operation actually added', async () => {
    const guarded = service();
    nextResult = {
      ok: true,
      pendingReboot: ['msyh.ttc', 'simsun.ttc'],
      scheduledDeleteNames: ['msyh.ttc'],
    };
    await guarded.remove();
    calls.length = 0;
    nextResult = { ok: true, pendingReboot: [], scheduledDeleteNames: [] };

    await guarded.restore();

    expect(calls[0]).toMatchObject({ mode: 'restore', scheduledDeleteNames: ['msyh.ttc'] });
  });

  it('refuses a second removal while reboot deletions from the previous operation remain', async () => {
    await mkdir(join(root, 'state'), { recursive: true });
    await writeFile(join(root, 'state', 'font-remove-last.json'), JSON.stringify({
      pendingReboot: ['msyh.ttc'],
      scheduledDeleteNames: ['msyh.ttc'],
    }));

    const result = await service().remove();

    expect(result).toEqual({ ok: false, error: '仍有字体等待重启删除；请先还原或重启后再检查' });
    expect(calls).toHaveLength(0);
  });

  it('does not report restore success or clear recovery state before read-back verification', async () => {
    await service().backup();
    await writeFile(join(fontsDir, 'msyh.ttc'), 'still-corrupted');
    await mkdir(join(root, 'state'), { recursive: true });
    const markerPath = join(root, 'state', 'font-remove-last.json');
    await writeFile(markerPath, JSON.stringify({ pendingReboot: ['msyh.ttc'] }));

    const result = await service().restore();

    expect(result).toEqual({ ok: false, error: '字体还原验证失败：msyh.ttc 内容不匹配' });
    expect(JSON.parse(await readFile(markerPath, 'utf8')).pendingReboot).toEqual(['msyh.ttc']);
  });

  it('rejects a corrupted backup before invoking the privileged restore runner', async () => {
    const dir = await service().backup();
    await writeFile(join(dir, 'fonts', 'msyh.ttc'), 'tampered-backup');

    const result = await service().restore();

    expect(result).toEqual({ ok: false, error: '字体备份无效：msyh.ttc 内容不匹配' });
    expect(calls).toHaveLength(0);
  });

  it('restore converts a legacy reg.exe export into the whitelist json (issue #49 兼容)', async () => {
    // 手工构造旧版备份目录（reg.exe export 形态，UTF-16LE）
    const dir = join(root, 'state', 'font-backup', '20260801-000000');
    await mkdir(join(dir, 'fonts'), { recursive: true });
    const legacyFont = Buffer.from('fake-yahei');
    await writeFile(join(dir, 'fonts', 'msyh.ttc'), legacyFont);
    await writeFile(join(dir, 'manifest.json'), JSON.stringify([{
      name: 'msyh.ttc',
      bytes: legacyFont.length,
      sha256: createHash('sha256').update(legacyFont).digest('hex'),
    }]), 'utf8');
    const regText = [
      'Windows Registry Editor Version 5.00',
      '',
      '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts]',
      '"Microsoft YaHei & Microsoft YaHei UI (TrueType)"="msyh.ttc"',
      '"Evil Persistence (TrueType)"="C:\\\\evil\\\\payload.ttf"',
      '',
    ].join('\r\n');
    await writeFile(join(dir, 'fonts-hklm.reg'), regText, 'utf16le');
    await writeFile(join(dir, 'restore-fonts.ps1'), '# legacy restore hint', 'utf8');
    const result = await service().restore();
    expect(result).toEqual({ ok: true, pendingReboot: [], scheduledDeleteNames: [] });
    expect(String(calls[0].regJsonPath)).toBe(join(dir, 'fonts-hklm.json'));
    const converted = JSON.parse(await readFile(join(dir, 'fonts-hklm.json'), 'utf8')) as { entries: FontRegistryEntries };
    expect(converted.entries).toEqual({ 'Microsoft YaHei & Microsoft YaHei UI (TrueType)': 'msyh.ttc' });
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
      runner: async () => ({ ok: true, pendingReboot: [], scheduledDeleteNames: [] }),
    });
    const foreign2 = join(root, 'state2', 'font-backup', '20260809-101752');
    await mkdir(foreign2, { recursive: true });
    await writeFile(join(foreign2, 'README.txt'), 'foreign');
    const result = await s2.restore();
    expect(result).toEqual({ ok: false, error: '字体备份不存在（或备份不完整）' });
    expect(calls).toHaveLength(0);
  });
});
