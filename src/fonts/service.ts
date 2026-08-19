// 字体修复流（ADR-0013）：备份 → 移除 → 还原。破坏性操作经特权助手执行。
// issue #49 安全强化：特权脚本与参数经命令行快照内嵌（不落盘）、备份材料锚定、
// 注册表还原走白名单 JSON 逐值写回（弃 reg.exe import）、结果标记带一次性 nonce。

import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { defaultPersistRoot } from '../state/paths.js';
import { isChineseFontFileName, isSafeFontFileName } from './catalog.js';
import { buildElevationLauncherArgs, composeElevatedFontScript, FONT_REGISTRY_JSON_NAME } from './elevated-script.js';

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
  /** restore：字体文件备份子目录（锚定 font-backup 子树）。 */
  backupDir?: string;
  /** restore：注册表还原 JSON（锚定 font-backup 子树、文件名固定）。 */
  regJsonPath?: string;
}>) => Promise<PrivilegedResult>;

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 注册表备份读出形状：值名 → 值数据（均为字符串）。 */
export type FontRegistryEntries = Readonly<Record<string, string>>;

/** 非提权读取 HKLM Fonts 键全部字符串值（Everyone 可读）。 */
async function readFontRegistrationsFromRegistry(): Promise<FontRegistryEntries> {
  const command = [
    "$key = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'",
    '$o = [ordered]@{}',
    'foreach ($p in (Get-Item $key).Property) { $o[$p] = [string](Get-ItemProperty $key -Name $p).$p }',
    '$o | ConvertTo-Json -Compress',
  ].join('; ');
  const text = await new Promise<string>((resolveRead, rejectRead) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', rejectRead);
    child.on('close', (code) => (code === 0 ? resolveRead(stdout) : rejectRead(new Error('registry read failed: ' + code))));
  });
  const parsed = JSON.parse(text) as Record<string, string>;
  return typeof parsed === 'object' && parsed !== null ? parsed : {};
}

/** 解析旧版 reg.exe export 材料（REGEDIT5/UTF-16）为键值表；仅接受 Fonts 键段。 */
export function parseRegFileToEntries(text: string): FontRegistryEntries {
  const entries: Record<string, string> = {};
  let inFontsKey = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('[')) {
      inFontsKey = /^\[HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts\]$/i.test(line);
      continue;
    }
    if (!inFontsKey) continue;
    const match = /^"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:;.*)?$/.exec(line);
    if (match === null) continue; // hex 值/默认值/注释等一律跳过
    const unescape = (value: string): string => value.replace(/\\(.)/g, (_, ch: string) => (ch === '\\' || ch === '"' ? ch : `\\${ch}`));
    entries[unescape(match[1]!)] = unescape(match[2]!);
  }
  return entries;
}

/**
 * 提权请求的 Node 端预检（纵深防御；参数本已内嵌命令行快照不可篡改）。
 * 返回错误消息或 null（通过）。
 */
export function validatePrivilegedRequest(
  request: Readonly<{ mode: string; backupDir?: string; regJsonPath?: string }>,
  anchorRoot: string,
): string | null {
  if (request.mode !== 'remove' && request.mode !== 'restore') return `unknown mode: ${request.mode}`;
  if (request.mode === 'remove') return null;
  const anchor = resolve(anchorRoot).toLowerCase();
  const anchored = (value: string): boolean => {
    if (!isAbsolute(value)) return false;
    const full = resolve(value).toLowerCase();
    return full === anchor || full.startsWith(anchor.endsWith('\\') ? anchor : anchor + '\\');
  };
  if (request.backupDir === undefined || !anchored(request.backupDir)) return 'backup dir escapes the backup anchor';
  if (request.regJsonPath !== undefined) {
    if (!anchored(request.regJsonPath)) return 'registry json escapes the backup anchor';
    if (basename(request.regJsonPath) !== FONT_REGISTRY_JSON_NAME) return 'unexpected registry json name';
  }
  return null;
}

export function createFontFixService(options: Readonly<{
  stateRoot: string;
  fontsDir?: string;
  runner?: FontPrivilegedRunner;
  now?: () => Date;
  /** 注册表读取注入点（测试用；默认非提权读 HKLM）。 */
  readFontRegistrations?: () => Promise<FontRegistryEntries>;
}>) {
  const stateRoot = options.stateRoot;
  const fontsDir = options.fontsDir ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts');
  const backupRoot = join(stateRoot, 'font-backup');
  const lastMarker = join(stateRoot, 'font-remove-last.json');
  const now = options.now ?? (() => new Date());
  const readFontRegistrations = options.readFontRegistrations ?? readFontRegistrationsFromRegistry;

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

  /** 仅当目录同时含 fonts/ 子目录（非空）与 manifest.json 时才视为产品备份（issue #46）。 */
  async function isCompleteProductBackup(dir: string): Promise<boolean> {
    try {
      const fontsSub = join(dir, 'fonts');
      const entries = await readdir(fontsSub);
      if (entries.length === 0) return false;
      await readFile(join(dir, 'manifest.json'), 'utf8');
      return true;
    } catch { return false; }
  }

  async function latestBackupDir(): Promise<string | null> {
    try {
      const entries = await readdir(backupRoot, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      dirs.sort().reverse();
      for (const name of dirs) {
        const dir = join(backupRoot, name);
        if (await isCompleteProductBackup(dir)) return dir;
      }
      return null;
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

  /** 备份目录中的注册表材料：优先既有 JSON；旧版 .reg 兼容转换后写回 JSON。
   * 转换与 backup 同语义过滤（仅中文字体相关值——它们才是 remove 删除、需要还原的项）。 */
  async function ensureRegistryJson(dir: string): Promise<string> {
    const jsonPath = join(dir, FONT_REGISTRY_JSON_NAME);
    try {
      await readFile(jsonPath, 'utf8');
      return jsonPath;
    } catch { /* 缺失则从旧 .reg 转换 */ }
    try {
      const all = parseRegFileToEntries(await readFile(join(dir, 'fonts-hklm.reg'), 'utf16le'));
      const entries = Object.fromEntries(
        Object.entries(all).filter(([, data]) => isChineseFontFileName(String(data).split('\\').pop() ?? '')),
      );
      await writeFile(jsonPath, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
    } catch { /* 旧 .reg 也不存在：写空表，还原时仅复制文件 */ }
    return jsonPath;
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
    // HKLM Fonts 注册表备份（白名单 JSON，还原时逐值写回；失败降级为空表）
    let entries: FontRegistryEntries = {};
    try {
      const all = await readFontRegistrations();
      entries = Object.fromEntries(
        Object.entries(all).filter(([, data]) => isChineseFontFileName(String(data).split('\\').pop() ?? '')),
      );
    } catch { /* 读失败：entries 置空，还原只恢复文件 */ }
    await writeFile(join(dir, FONT_REGISTRY_JSON_NAME), JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
    await writeFile(join(dir, 'restore-fonts.ps1'), RESTORE_HINT_SCRIPT, 'utf8');
    return dir;
  }

  async function remove(): Promise<PrivilegedResult> {
    await backup();
    // 移除名单由提权端按同一模式目录枚举（不传输、不可篡改）。
    const result = await runner({ mode: 'remove' });
    if (result.ok) {
      await writeFile(lastMarker, JSON.stringify({ pendingReboot: result.pendingReboot, at: now().toISOString() }), 'utf8');
    }
    return result;
  }

  async function restore(): Promise<PrivilegedResult> {
    const dir = await latestBackupDir();
    if (dir === null) return { ok: false, error: '字体备份不存在（或备份不完整）' };
    const regJsonPath = await ensureRegistryJson(dir);
    const result = await runner({ mode: 'restore', backupDir: join(dir, 'fonts'), regJsonPath });
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

/** 解析特权助手结果标记；剥离 Windows PowerShell 5.1 的 UTF-8 BOM（JSON.parse 会因 BOM 抛错）。
 * 带 expectedNonce 时校验一次性 nonce（伪造的 marker 被忽略）；pendingReboot 逐项过
 * 文件名白名单、error 截断，防止伪造内容注入 GUI。 */
export function parsePrivilegedMarker(text: string, expectedNonce?: string): PrivilegedResult | undefined {
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as {
      ok?: boolean;
      pendingReboot?: unknown;
      error?: unknown;
      nonce?: unknown;
    };
    if (expectedNonce !== undefined && parsed.nonce !== expectedNonce) return undefined;
    if (parsed.ok === true) {
      const pending = Array.isArray(parsed.pendingReboot)
        ? parsed.pendingReboot.filter((name): name is string => typeof name === 'string' && isSafeFontFileName(name))
        : [];
      return { ok: true, pendingReboot: pending };
    }
    if (parsed.ok === false) {
      const error = typeof parsed.error === 'string' ? parsed.error : '特权助手失败';
      return { ok: false, error: error.length > 500 ? `${error.slice(0, 500)}…` : error };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 默认特权执行器：脚本+参数经命令行快照内嵌（issue #49），随机 marker 文件名 + 一次性 nonce。 */
export function createElevatedFontRunner(stateRoot: string): FontPrivilegedRunner {
  return async (request) => {
    const anchorRoot = resolve(join(stateRoot, 'font-backup'));
    const invalid = validatePrivilegedRequest(request, anchorRoot);
    if (invalid !== null) return { ok: false, error: invalid };
    const markerPath = join(stateRoot, `font-helper-result-${randomUUID()}.json`);
    const nonce = randomBytes(32).toString('hex');
    const script = composeElevatedFontScript({ request, anchorRoot, markerPath, nonce });
    const launcherArgs = buildElevationLauncherArgs(script);
    await mkdir(stateRoot, { recursive: true });
    try { await rm(markerPath, { force: true }); } catch { /* 尚不存在 */ }
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const child = spawn('powershell.exe', launcherArgs, { windowsHide: true });
      child.on('error', rejectSpawn);
      child.on('close', (code) => (code === 0 ? resolveSpawn() : rejectSpawn(new Error('elevation spawn failed: ' + code))));
    });
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const parsed = parsePrivilegedMarker(await readFile(markerPath, 'utf8'), nonce);
        if (parsed !== undefined) {
          await rm(markerPath, { force: true }).catch(() => undefined);
          return parsed;
        }
      } catch { } // 标记尚未写出或为伪造内容（nonce 不符），继续轮询
      if (Date.now() > deadline) return { ok: false, error: '特权助手超时（UAC 未确认？）' };
      await new Promise((r) => setTimeout(r, 500));
    }
  };
}

/** GUI 默认实例：状态根 = defaultPersistRoot。 */
export function createDefaultFontFixService() {
  return createFontFixService({ stateRoot: defaultPersistRoot(process.env) });
}
