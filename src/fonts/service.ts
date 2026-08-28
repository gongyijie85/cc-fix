// 字体修复流（ADR-0013）：备份 → 移除 → 还原。破坏性操作经特权助手执行。
// issue #49 安全强化：特权脚本与参数经命令行快照内嵌（不落盘）、备份材料锚定、
// 注册表还原走白名单 JSON 逐值写回（弃 reg.exe import）、结果标记带一次性 nonce。

import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { defaultPersistRoot } from '../state/paths.js';
import { isChineseFontFileName, isSafeFontFileName } from './catalog.js';
import { buildElevationLauncherArgs, composeElevatedFontScript, FONT_REGISTRY_JSON_NAME, type ElevatedFontRequest } from './elevated-script.js';

export type FontFixStatus = Readonly<{
  fontsDir: string;
  found: string[];
  backedUp: boolean;
  backupDir: string | null;
  pendingReboot: string[];
}>;

export type PrivilegedResult = Readonly<
  { ok: true; pendingReboot: string[]; scheduledDeleteNames: string[] }
  | { ok: false; error: string }
>;

export type FontPrivilegedRequest = ElevatedFontRequest;

export type FontPrivilegedRunner = (request: FontPrivilegedRequest) => Promise<PrivilegedResult>;

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 注册表备份读出形状：值名 → 值数据（均为字符串）。 */
export type FontRegistryEntries = Readonly<Record<string, string>>;
type FontManifestEntry = Readonly<{ name: string; bytes: number; sha256: string }>;

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
  request: Readonly<{ mode: string; expectedNames?: readonly string[]; backupDir?: string; regJsonPath?: string; scheduledDeleteNames?: readonly string[] }>,
  anchorRoot: string,
): string | null {
  if (request.mode !== 'remove' && request.mode !== 'restore') return `unknown mode: ${request.mode}`;
  if (request.mode === 'remove') {
    if (!Array.isArray(request.expectedNames) || request.expectedNames.length === 0) return 'remove inventory is empty';
    const normalized = new Set<string>();
    for (const name of request.expectedNames) {
      if (!isSafeFontFileName(name)) return `invalid font name: ${name}`;
      normalized.add(name.toLowerCase());
    }
    if (normalized.size !== request.expectedNames.length) return 'remove inventory contains duplicates';
    return null;
  }
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
  for (const name of request.scheduledDeleteNames ?? []) {
    if (!isSafeFontFileName(name)) return `invalid scheduled font name: ${name}`;
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
      const entries = await readdir(fontsSub, { withFileTypes: true });
      if (entries.length === 0 || entries.some((entry) => !entry.isFile())) return false;
      const parsed = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== entries.length) return false;
      const manifestNames = parsed.map((entry) => String((entry as { name?: unknown }).name)).sort();
      const fileNames = entries.map((entry) => entry.name).sort();
      if (manifestNames.some((name) => !isSafeFontFileName(name)) || manifestNames.some((name, index) => name !== fileNames[index])) return false;
      try {
        await readFile(join(dir, FONT_REGISTRY_JSON_NAME), 'utf8');
      } catch {
        await readFile(join(dir, 'fonts-hklm.reg'));
      }
      await readFile(join(dir, 'restore-fonts.ps1'), 'utf8');
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

  async function lastRemovalState(): Promise<{ pendingReboot: string[]; scheduledDeleteNames: string[] }> {
    try {
      const parsed = JSON.parse(await readFile(lastMarker, 'utf8')) as { pendingReboot?: unknown; scheduledDeleteNames?: unknown };
      const pending = Array.isArray(parsed.pendingReboot) ? parsed.pendingReboot.filter((name): name is string => typeof name === 'string' && isSafeFontFileName(name)) : [];
      const scheduled = Array.isArray(parsed.scheduledDeleteNames)
        ? parsed.scheduledDeleteNames.filter((name): name is string => typeof name === 'string' && isSafeFontFileName(name))
        : pending;
      return { pendingReboot: pending, scheduledDeleteNames: scheduled };
    } catch { return { pendingReboot: [], scheduledDeleteNames: [] }; }
  }

  async function status(): Promise<FontFixStatus> {
    const found = await foundFonts();
    const backupDir = await latestBackupDir();
    return Object.freeze({ fontsDir, found, backedUp: backupDir !== null, backupDir, pendingReboot: (await lastRemovalState()).pendingReboot });
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

  async function verifyRestoredBackup(dir: string, regJsonPath: string): Promise<string | null> {
    let manifest: FontManifestEntry[];
    try {
      const parsed = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) return '备份清单为空';
      manifest = parsed as FontManifestEntry[];
    } catch {
      return '无法读取备份清单';
    }
    for (const entry of manifest) {
      if (!isSafeFontFileName(entry.name) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/iu.test(entry.sha256)) {
        return `备份清单无效：${String(entry.name)}`;
      }
      try {
        const live = await readFile(join(fontsDir, entry.name));
        if (live.length !== entry.bytes || sha256(live) !== entry.sha256.toLowerCase()) return `${entry.name} 内容不匹配`;
      } catch {
        return `${entry.name} 不存在`;
      }
    }
    try {
      const document = JSON.parse(await readFile(regJsonPath, 'utf8')) as { entries?: FontRegistryEntries };
      const expected = document.entries ?? {};
      const actual = await readFontRegistrations();
      for (const [name, data] of Object.entries(expected)) {
        if (actual[name] !== data) return `注册表项不匹配：${name}`;
      }
    } catch {
      return '无法验证字体注册表';
    }
    return null;
  }

  async function validateBackupMaterial(dir: string, regJsonPath: string): Promise<string | null> {
    let manifest: FontManifestEntry[];
    try {
      const parsed = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) return '备份清单为空';
      manifest = parsed as FontManifestEntry[];
    } catch {
      return '无法读取备份清单';
    }
    const names = new Set<string>();
    for (const entry of manifest) {
      const normalized = String(entry.name).toLowerCase();
      if (!isSafeFontFileName(entry.name) || names.has(normalized) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/iu.test(entry.sha256)) {
        return `备份清单无效：${String(entry.name)}`;
      }
      names.add(normalized);
      try {
        const data = await readFile(join(dir, 'fonts', entry.name));
        if (data.length !== entry.bytes || sha256(data) !== entry.sha256.toLowerCase()) return `${entry.name} 内容不匹配`;
      } catch {
        return `${entry.name} 不存在`;
      }
    }
    try {
      const files = await readdir(join(dir, 'fonts'), { withFileTypes: true });
      if (files.length !== manifest.length || files.some((entry) => !entry.isFile() || !names.has(entry.name.toLowerCase()))) return '字体文件集合与清单不一致';
      const document = JSON.parse(await readFile(regJsonPath, 'utf8')) as { version?: unknown; entries?: unknown };
      if (document.version !== 1 || typeof document.entries !== 'object' || document.entries === null || Array.isArray(document.entries)) return '字体注册表备份无效';
      for (const [name, data] of Object.entries(document.entries)) {
        if (typeof name !== 'string' || typeof data !== 'string') return '字体注册表备份无效';
      }
    } catch {
      return '无法读取字体注册表备份';
    }
    return null;
  }

  async function allocateBackupDir(stamp: string): Promise<string> {
    await mkdir(backupRoot, { recursive: true });
    for (let suffix = 0; suffix < 10_000; suffix += 1) {
      const name = suffix === 0 ? stamp : `${stamp}-${String(suffix).padStart(4, '0')}`;
      const dir = join(backupRoot, name);
      try {
        await mkdir(dir);
        return dir;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('无法分配唯一字体备份目录');
  }

  async function createBackup(reuseExisting: boolean): Promise<string> {
    if (reuseExisting) {
      const existing = await latestBackupDir();
      if (existing !== null) return existing;
    }
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const dir = await allocateBackupDir(stamp);
    try {
      const fontsSub = join(dir, 'fonts');
      await mkdir(fontsSub);
      const found = await foundFonts();
      if (found.length === 0) throw new Error('未发现可备份的中文字体');
      const manifest = [];
      const failed: string[] = [];
      for (const name of found) {
        if (!isSafeFontFileName(name)) { failed.push(name); continue; }
        const source = join(fontsDir, name);
        try {
          const data = await readFile(source);
          await copyFile(source, join(fontsSub, name));
          manifest.push({ name, bytes: data.length, sha256: sha256(data) });
        } catch { failed.push(name); }
      }
      if (failed.length > 0) throw new Error(`字体备份不完整：无法备份 ${failed.join(', ')}`);
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
      // HKLM Fonts 注册表备份（白名单 JSON，还原时逐值写回；失败则阻止删除）
      let entries: FontRegistryEntries;
      try {
        const all = await readFontRegistrations();
        entries = Object.fromEntries(
          Object.entries(all).filter(([, data]) => isChineseFontFileName(String(data).split('\\').pop() ?? '')),
        );
      } catch {
        throw new Error('字体备份不完整：无法读取字体注册表');
      }
      await writeFile(join(dir, FONT_REGISTRY_JSON_NAME), JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
      await writeFile(join(dir, 'restore-fonts.ps1'), RESTORE_HINT_SCRIPT, 'utf8');
      return dir;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** 显式备份保持幂等；真正移除前由 remove() 强制创建当前版本的新备份。 */
  async function backup(): Promise<string> {
    return createBackup(true);
  }

  async function remove(): Promise<PrivilegedResult> {
    if ((await lastRemovalState()).pendingReboot.length > 0) {
      return { ok: false, error: '仍有字体等待重启删除；请先还原或重启后再检查' };
    }
    let dir: string;
    try {
      dir = await createBackup(false);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const regJsonPath = join(dir, FONT_REGISTRY_JSON_NAME);
    const backupError = await validateBackupMaterial(dir, regJsonPath);
    if (backupError !== null) {
      await rm(dir, { recursive: true, force: true });
      return { ok: false, error: `字体备份无效：${backupError}` };
    }
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Array<{ name: string }>;
    const expectedNames = manifest.map((entry) => entry.name).sort();
    const result = await runner({ mode: 'remove', expectedNames });
    if (result.ok) {
      await writeFile(lastMarker, JSON.stringify({
        pendingReboot: result.pendingReboot,
        scheduledDeleteNames: result.scheduledDeleteNames,
        at: now().toISOString(),
      }), 'utf8');
    }
    return result;
  }

  async function restore(): Promise<PrivilegedResult> {
    const dir = await latestBackupDir();
    if (dir === null) return { ok: false, error: '字体备份不存在（或备份不完整）' };
    const regJsonPath = await ensureRegistryJson(dir);
    const backupError = await validateBackupMaterial(dir, regJsonPath);
    if (backupError !== null) return { ok: false, error: `字体备份无效：${backupError}` };
    const scheduledDeleteNames = (await lastRemovalState()).scheduledDeleteNames;
    const result = await runner({ mode: 'restore', backupDir: join(dir, 'fonts'), regJsonPath, scheduledDeleteNames });
    if (result.ok) {
      const verificationError = await verifyRestoredBackup(dir, regJsonPath);
      if (verificationError !== null) return { ok: false, error: `字体还原验证失败：${verificationError}` };
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
      scheduledDeleteNames?: unknown;
      error?: unknown;
      nonce?: unknown;
    };
    if (expectedNonce !== undefined && parsed.nonce !== expectedNonce) return undefined;
    if (parsed.ok === true) {
      const pending = Array.isArray(parsed.pendingReboot)
        ? parsed.pendingReboot.filter((name): name is string => typeof name === 'string' && isSafeFontFileName(name))
        : [];
      const scheduled = Array.isArray(parsed.scheduledDeleteNames)
        ? parsed.scheduledDeleteNames.filter((name): name is string => typeof name === 'string' && isSafeFontFileName(name))
        : pending;
      return { ok: true, pendingReboot: pending, scheduledDeleteNames: scheduled };
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
