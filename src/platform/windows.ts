// Windows 平台适配 — 环境变量持久化

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const APPDATA = process.env.APPDATA || path.join(process.env.HOME || "", ".config");
const CC_FIX_DIR = path.join(APPDATA, "cc-fix");
const BACKUP_FILE = path.join(CC_FIX_DIR, "persist-backup.json");

export type BackupData = {
  timestamp: string;
  previous: Record<string, string | null>;
  /** persist on 前的 Windows 系统时区（tzutil ID），旧备份可能缺失 */
  previousSystemTimezone?: string | null;
};

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

  const backup: BackupData = {
    timestamp: new Date().toISOString(),
    previous,
    previousSystemTimezone,
  };

  fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2), "utf-8");
  return backup;
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
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2), "utf-8");
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

export function getPersistStatus(): {
  enabled: boolean;
  backup: BackupData | null;
  current: Record<string, string | null>;
} {
  const backup = loadBackup();
  const envKeys = ["TZ", "LANG", "LC_ALL"];
  const current: Record<string, string | null> = {};

  for (const key of envKeys) {
    current[key] = getEnvVar(key);
  }

  return {
    enabled: backup !== null,
    backup,
    current,
  };
}
