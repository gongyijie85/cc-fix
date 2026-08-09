// Windows 平台适配 — 环境变量持久化

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { snapshotPolicies, type BrowserPolicySnapshot } from "./browser.js";

const APPDATA = process.env.APPDATA || path.join(process.env.HOME || "", ".config");
const CC_FIX_DIR = path.join(APPDATA, "cc-fix");
const BACKUP_FILE = path.join(CC_FIX_DIR, "persist-backup.json");

/** 备份 schema：v3 = 含 activeRegion / 语言列表 / Culture */
export const BACKUP_SCHEMA_VERSION = 3;

export type BackupData = {
  timestamp: string;
  /** 备份格式版本；旧文件可能缺失 */
  schemaVersion?: number;
  /** 安全模式目标地区（首次 on 写入，之后不覆盖） */
  activeRegion?: string;
  previous: Record<string, string | null>;
  /** persist on 前的 Windows 系统时区（tzutil ID），旧备份可能缺失 */
  previousSystemTimezone?: string | null;
  /** persist on 前的浏览器策略原值（含"不存在"），旧备份可能缺失（ADR-0003） */
  previousBrowserPolicies?: BrowserPolicySnapshot;
  /** persist on 前的 Windows 区域格式 LocaleName，旧备份可能缺失 */
  previousLocaleName?: string | null;
  /** persist on 前的用户首选语言列表（LanguageTag），旧备份可能缺失 */
  previousUserLanguages?: string[] | null;
  /** persist on 前的用户 Culture（Get-Culture），旧备份可能缺失 */
  previousUserCulture?: string | null;
};

/** 原子写入备份 JSON（先写临时文件再替换，降低半写风险） */
function writeBackupAtomic(backup: BackupData): void {
  ensureDir();
  const tmp = path.join(CC_FIX_DIR, `.persist-backup.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(backup, null, 2), "utf-8");
  try {
    fs.renameSync(tmp, BACKUP_FILE);
  } catch {
    // Windows 上目标已存在时 rename 可能失败：回退为覆盖拷贝
    fs.copyFileSync(tmp, BACKUP_FILE);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略临时文件清理失败
    }
  }
}

export function ensureDir(): void {
  if (!fs.existsSync(CC_FIX_DIR)) {
    fs.mkdirSync(CC_FIX_DIR, { recursive: true });
  }
}

export function createBackup(envKeys: string[]): BackupData {
  // 如果已有备份，不覆盖——保留最原始的原始值
  const existing = loadBackup();
  if (existing) {
    return existing;
  }

  ensureDir();

  const previous: Record<string, string | null> = {};

  for (const key of envKeys) {
    try {
      const result = execSync(
        `reg query "HKCU\\Environment" /v ${key} 2>nul`,
        { encoding: "utf-8" }
      );
      const match = result.match(/REG_SZ\s+(.+)/);
      previous[key] = match ? match[1].trim() : null;
    } catch {
      previous[key] = null;
    }
  }

  // 同时记录当前系统时区，供 persist off 恢复
  let previousSystemTimezone: string | null = null;
  try {
    previousSystemTimezone = getSystemTimezone();
  } catch {
    // tzutil 不可用时保留 null，不阻断备份
  }

  // 同时快照浏览器策略原值（含"不存在"），供 persist off 精确还原
  let previousBrowserPolicies: BrowserPolicySnapshot | undefined;
  try {
    previousBrowserPolicies = snapshotPolicies();
  } catch {
    // 策略快照失败不阻断备份，后续写入步骤会自行报错
  }

  // 同时记录 Windows 区域格式（LocaleName），供 persist off 恢复
  let previousLocaleName: string | null = null;
  try {
    previousLocaleName = getWindowsLocaleName();
  } catch {
    // 读取失败不阻断备份
  }

  // 用户首选语言列表 + Culture（checkcc 读 navigator.languages / Intl 的根因）
  let previousUserLanguages: string[] | null = null;
  try {
    previousUserLanguages = getUserLanguageTags();
  } catch {
    previousUserLanguages = null;
  }
  let previousUserCulture: string | null = null;
  try {
    previousUserCulture = getUserCulture();
  } catch {
    previousUserCulture = null;
  }

  const backup: BackupData = {
    timestamp: new Date().toISOString(),
    schemaVersion: BACKUP_SCHEMA_VERSION,
    previous,
    previousSystemTimezone,
    previousBrowserPolicies,
    previousLocaleName,
    previousUserLanguages,
    previousUserCulture,
  };

  writeBackupAtomic(backup);
  return backup;
}

/** 首次 on 时记录目标地区；已有则不改（保持「最原始日常配置」语义） */
export function patchBackupActiveRegion(regionCode: string): void {
  const backup = loadBackup();
  if (!backup) return;
  if (backup.activeRegion) return;
  backup.activeRegion = regionCode;
  backup.schemaVersion = BACKUP_SCHEMA_VERSION;
  writeBackupAtomic(backup);
}

// ── 进程互斥锁：防止 on/off 并发导致半切换 ──

const LOCK_FILE = path.join(CC_FIX_DIR, "persist.lock");
const LOCK_STALE_MS = 5 * 60 * 1000;

export function acquirePersistLock(): void {
  ensureDir();
  if (fs.existsSync(LOCK_FILE)) {
    const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (age < LOCK_STALE_MS) {
      throw new Error("另一进程正在执行 persist on/off，请稍后再试");
    }
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      // 过期锁删失败仍尝试覆盖
    }
  }
  fs.writeFileSync(
    LOCK_FILE,
    JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    "utf-8",
  );
}

export function releasePersistLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch {
    // 忽略
  }
}

export function loadBackup(): BackupData | null {
  if (!fs.existsSync(BACKUP_FILE)) {
    return null;
  }

  try {
    const content = fs.readFileSync(BACKUP_FILE, "utf-8");
    return JSON.parse(content) as BackupData;
  } catch {
    return null;
  }
}

export function setEnvVar(key: string, value: string): void {
  execSync(`setx ${key} "${value}"`, { stdio: "pipe" });
}

// ── 系统时区（tzutil）──

export function getSystemTimezone(): string {
  return execSync("tzutil /g", { encoding: "utf-8" }).trim();
}

export function setSystemTimezone(winTimezoneId: string): void {
  execSync(`tzutil /s "${winTimezoneId}"`, { stdio: "pipe" });
}

// 为旧备份补写系统时区字段（不改写已有字段）
export function patchBackupSystemTimezone(winTimezoneId: string): void {
  const backup = loadBackup();
  if (!backup || backup.previousSystemTimezone !== undefined) return;
  backup.previousSystemTimezone = winTimezoneId;
  writeBackupAtomic(backup);
}

// 为旧备份补写浏览器策略快照字段（不改写已有字段）
export function patchBackupBrowserPolicies(snapshot: BrowserPolicySnapshot): void {
  const backup = loadBackup();
  if (!backup || backup.previousBrowserPolicies !== undefined) return;
  backup.previousBrowserPolicies = snapshot;
  writeBackupAtomic(backup);
}

// 为旧备份补写区域格式字段（不改写已有字段）
export function patchBackupLocaleName(localeName: string | null): void {
  const backup = loadBackup();
  if (!backup || backup.previousLocaleName !== undefined) return;
  backup.previousLocaleName = localeName;
  writeBackupAtomic(backup);
}

// ── Windows 区域格式（HKCU\Control Panel\International\LocaleName）──

/** en_US.UTF-8 → en-US */
export function localeNameFromLang(lang: string): string {
  return lang.split(".")[0]!.replace("_", "-");
}

export function getWindowsLocaleName(): string | null {
  try {
    const output = execSync(
      'reg query "HKCU\\Control Panel\\International" /v LocaleName',
      { encoding: "utf-8", timeout: 3000, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const match = output.match(/LocaleName\s+REG_SZ\s+(\S+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function setWindowsLocaleName(localeName: string): void {
  execSync(
    `reg add "HKCU\\Control Panel\\International" /v LocaleName /t REG_SZ /d "${localeName}" /f`,
    { stdio: "pipe" },
  );
}

// ── 用户首选语言 / Culture（对标 check-cc client-engine：navigator.languages）──

function runPowerShell(command: string): string {
  return execSync(`powershell -NoProfile -NonInteractive -Command ${JSON.stringify(command)}`, {
    encoding: "utf-8",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15000,
  }).trim();
}

export function getUserLanguageTags(): string[] {
  const out = runPowerShell("(Get-WinUserLanguageList).LanguageTag -join ','");
  if (!out) return [];
  return out.split(",").map((s) => s.trim()).filter(Boolean);
}

/** 将首选语言设为单一目标标签（去掉 zh-CN 等中文项，降低 checkcc 语言分） */
export function setUserLanguageListPrimary(languageTag: string): void {
  // 使用单引号包标签，避免 PowerShell 注入
  const tag = languageTag.replace(/'/g, "''");
  runPowerShell(
    `$list = New-WinUserLanguageList -Language '${tag}'; Set-WinUserLanguageList -LanguageList $list -Force`,
  );
}

export function restoreUserLanguageList(tags: string[]): void {
  if (tags.length === 0) return;
  const quoted = tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(",");
  runPowerShell(
    `$tags = @(${quoted}); $list = New-WinUserLanguageList -Language $tags[0]; ` +
      `foreach ($t in $tags | Select-Object -Skip 1) { $list.Add($t) | Out-Null }; ` +
      `Set-WinUserLanguageList -LanguageList $list -Force`,
  );
}

export function getUserCulture(): string | null {
  try {
    const out = runPowerShell("(Get-Culture).Name");
    return out || null;
  } catch {
    return null;
  }
}

export function setUserCulture(cultureTag: string): void {
  const tag = cultureTag.replace(/'/g, "''");
  runPowerShell(`Set-Culture -CultureInfo '${tag}'`);
}

export function patchBackupUserLanguages(tags: string[] | null): void {
  const backup = loadBackup();
  if (!backup || backup.previousUserLanguages !== undefined) return;
  backup.previousUserLanguages = tags;
  writeBackupAtomic(backup);
}

export function patchBackupUserCulture(culture: string | null): void {
  const backup = loadBackup();
  if (!backup || backup.previousUserCulture !== undefined) return;
  backup.previousUserCulture = culture;
  writeBackupAtomic(backup);
}

export function deleteEnvVar(key: string): void {
  try {
    execSync(`reg delete "HKCU\\Environment" /v ${key} /f`, { stdio: "pipe" });
  } catch {
    // 变量可能不存在，忽略
  }
}

export function getEnvVar(key: string): string | null {
  try {
    const result = execSync(
      `reg query "HKCU\\Environment" /v ${key} 2>nul`,
      { encoding: "utf-8" }
    );
    const match = result.match(/REG_SZ\s+(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

export function restoreBackup(backup: BackupData): void {
  for (const [key, value] of Object.entries(backup.previous)) {
    if (value === null) {
      deleteEnvVar(key);
    } else {
      setEnvVar(key, value);
    }
  }

  // 删除备份文件
  if (fs.existsSync(BACKUP_FILE)) {
    fs.unlinkSync(BACKUP_FILE);
  }
}

export function isPersisted(): boolean {
  return fs.existsSync(BACKUP_FILE);
}

export type PersistMode = "secure" | "daily";

export type PersistStatus = {
  /** 是否存在可还原的日常备份（即是否处于安全模式） */
  enabled: boolean;
  /** secure = 已 on；daily = 未 on / 已 off */
  mode: PersistMode;
  /** 安全模式目标地区 */
  activeRegion: string | null;
  backup: BackupData | null;
  /** 用户级环境变量当前值 */
  current: Record<string, string | null>;
  /** 当前 Windows 系统时区（tzutil），读取失败为 null */
  systemTimezone: string | null;
  /** 当前区域格式 LocaleName，读取失败为 null */
  localeName: string | null;
};

export function getPersistStatus(): PersistStatus {
  const backup = loadBackup();
  const envKeys = ["TZ", "LANG", "LC_ALL"];
  const current: Record<string, string | null> = {};

  for (const key of envKeys) {
    current[key] = getEnvVar(key);
  }

  let systemTimezone: string | null = null;
  try {
    systemTimezone = getSystemTimezone();
  } catch {
    systemTimezone = null;
  }

  let localeName: string | null = null;
  try {
    localeName = getWindowsLocaleName();
  } catch {
    localeName = null;
  }

  return {
    enabled: backup !== null,
    mode: backup !== null ? "secure" : "daily",
    activeRegion: backup?.activeRegion ?? null,
    backup,
    current,
    systemTimezone,
    localeName,
  };
}
