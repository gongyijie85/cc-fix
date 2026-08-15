// 字体修复流（ADR-0013）：备份 → 移除 → 还原。破坏性操作经特权助手执行。

import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { defaultPersistRoot } from '../state/paths.js';
import { isChineseFontFileName, isSafeFontFileName } from './catalog.js';
import { ELEVATED_FONT_SCRIPT } from './elevated-script.js';

export type FontFixStatus = Readonly<{
  fontsDir: string;
  found: string[];
  backedUp: boolean;
  backupDir: string | null;
  pendingReboot: string[];
}>;

export type PrivilegedResult = Readonly<{ ok: true; pendingReboot: string[] } | { ok: false; error: string }>;

export type FontPrivilegedRunner = (request: Readonly<{
  mode: 'remove' | 'restore';
  fonts?: string[];
  backupDir?: string;
  regFile?: string;
}>) => Promise<PrivilegedResult>;

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function createFontFixService(options: Readonly<{
  stateRoot: string;
  fontsDir?: string;
  runner?: FontPrivilegedRunner;
  now?: () => Date;
}>) {
  const stateRoot = options.stateRoot;
  const fontsDir = options.fontsDir ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts');
  const backupRoot = join(stateRoot, 'font-backup');
  const lastMarker = join(stateRoot, 'font-remove-last.json');
  const now = options.now ?? (() => new Date());

  const runner: FontPrivilegedRunner = options.runner ?? createElevatedFontRunner(stateRoot);

  async function foundFonts(): Promise<string[]> {
    try {
      const files = await readdir(fontsDir);
      const found = new Set<string>();
      for (const file of files) {
        if (isChineseFontFileName(file)) found.add(file);
      }
      return [...found].sort();
    } catch { return []; }
  }

  async function latestBackupDir(): Promise<string | null> {
    try {
      const entries = await readdir(backupRoot, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      if (dirs.length === 0) return null;
      dirs.sort().reverse();
      return join(backupRoot, dirs[0]);
    } catch { return null; }
  }

  async function pendingReboot(): Promise<string[]> {
    try {
      const parsed = JSON.parse(await readFile(lastMarker, 'utf8')) as { pendingReboot?: string[] };
      return Array.isArray(parsed.pendingReboot) ? parsed.pendingReboot : [];
    } catch { return []; }
  }

  async function status(): Promise<FontFixStatus> {
    const found = await foundFonts();
    const backupDir = await latestBackupDir();
    return Object.freeze({ fontsDir, found, backedUp: backupDir !== null, backupDir, pendingReboot: await pendingReboot() });
  }

  /** 幂等备份：已存在备份时不重复创建。返回备份目录。 */
  async function backup(): Promise<string> {
    const existing = await latestBackupDir();
    if (existing !== null) return existing;
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const dir = join(backupRoot, stamp);
    const fontsSub = join(dir, 'fonts');
    await mkdir(fontsSub, { recursive: true });
    const found = await foundFonts();
    const manifest = [];
    for (const name of found) {
      if (!isSafeFontFileName(name)) continue;
      const source = join(fontsDir, name);
      try {
        const data = await readFile(source);
        await copyFile(source, join(fontsSub, name));
        manifest.push({ name, bytes: data.length, sha256: sha256(data) });
      } catch { /* 文件占用/读取失败跳过，移除时再按 pending 处理 */ }
    }
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    // HKLM Fonts 注册表导出（还原材料）
    await new Promise<void>((resolveExport) => {
      const child = spawn('reg.exe', ['export', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', join(dir, 'fonts-hklm.reg'), '/y'], { windowsHide: true });
      child.on('close', () => resolveExport());
      child.on('error', () => resolveExport());
    });
    await writeFile(join(dir, 'restore-fonts.ps1'), RESTORE_HINT_SCRIPT, 'utf8');
    return dir;
  }

  async function remove(): Promise<PrivilegedResult> {
    await backup();
    const found = await foundFonts();
    const result = await runner({ mode: 'remove', fonts: found });
    if (result.ok) {
      await writeFile(lastMarker, JSON.stringify({ pendingReboot: result.pendingReboot, at: now().toISOString() }), 'utf8');
    }
    return result;
  }

  async function restore(): Promise<PrivilegedResult> {
    const dir = await latestBackupDir();
    if (dir === null) return { ok: false, error: '字体备份不存在' };
    const result = await runner({ mode: 'restore', backupDir: join(dir, 'fonts'), regFile: join(dir, 'fonts-hklm.reg') });
    if (result.ok) {
      await writeFile(lastMarker, JSON.stringify({ pendingReboot: [] }), 'utf8');
    }
    return result;
  }

  return Object.freeze({ status, backup, remove, restore });
}

/** 还原脚本提示（真正的还原经产品内 restore() 完成；此文件仅为手动兜底说明）。 */
const RESTORE_HINT_SCRIPT = [
  '# 请使用 CC-Fix GUI 的「还原中文字体」按钮；本文件仅为备份目录说明。',
].join('\n');

/** 解析特权助手结果标记；剥离 Windows PowerShell 5.1 的 UTF-8 BOM（JSON.parse 会因 BOM 抛错）。 */
export function parsePrivilegedMarker(text: string): PrivilegedResult | undefined {
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as PrivilegedResult & { ok: boolean };
    if (parsed.ok === true) return { ok: true, pendingReboot: (parsed as { pendingReboot?: string[] }).pendingReboot ?? [] };
    if (parsed.ok === false) return { ok: false, error: (parsed as { error?: string }).error ?? '特权助手失败' };
    return undefined;
  } catch {
    return undefined;
  }
}

/** 默认特权执行器：Start-Process -Verb RunAs + 完成标记文件等待。 */
export function createElevatedFontRunner(stateRoot: string): FontPrivilegedRunner {
  return async (request) => {
    const scriptPath = join(stateRoot, 'font-helper.ps1');
    const argsPath = join(stateRoot, 'font-helper-args.json');
    const markerPath = join(stateRoot, 'font-helper-result.json');
    await mkdir(stateRoot, { recursive: true });
    await writeFile(scriptPath, ELEVATED_FONT_SCRIPT, 'utf8');
    await writeFile(argsPath, JSON.stringify(request), 'utf8');
    try { await import('node:fs/promises').then((fs) => fs.rm(markerPath, { force: true })); } catch {}
    const ps = "Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','" + scriptPath.replace(/'/g, "''") + "','" + argsPath.replace(/'/g, "''") + "','" + markerPath.replace(/'/g, "''") + "')";
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true });
      child.on('error', rejectSpawn);
      child.on('close', (code) => (code === 0 ? resolveSpawn() : rejectSpawn(new Error('elevation spawn failed: ' + code))));
    });
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const parsed = parsePrivilegedMarker(await readFile(markerPath, 'utf8'));
        if (parsed !== undefined) return parsed;
      } catch { } // 标记尚未写出，继续轮询
      if (Date.now() > deadline) return { ok: false, error: '特权助手超时（UAC 未确认？）' };
      await new Promise((r) => setTimeout(r, 500));
    }
  };
}

/** GUI 默认实例：状态根 = defaultPersistRoot。 */
export function createDefaultFontFixService() {
  return createFontFixService({ stateRoot: defaultPersistRoot(process.env) });
}