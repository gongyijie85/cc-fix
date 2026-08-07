// 编排层 — 修复流（persist on/off）的步骤化执行

import fs from "node:fs";
import path from "node:path";
import type { EventConsumer } from "../events/types.js";
import {
  createBackup,
  setEnvVar,
  deleteEnvVar,
  getEnvVar,
  getPersistStatus,
  getSystemTimezone,
  setSystemTimezone,
  patchBackupSystemTimezone,
  patchBackupBrowserPolicies,
  type BackupData,
} from "../platform/windows.js";
import {
  POLICY_SLOTS,
  slotKey,
  targetPolicies,
  getPolicy,
  setPolicy,
  deletePolicy,
  snapshotPolicies,
  detectRunningBrowsers,
} from "../platform/browser.js";

const APPDATA = process.env.APPDATA || path.join(process.env.HOME || "", ".config");
const BACKUP_FILE = path.join(APPDATA, "cc-fix", "persist-backup.json");

export interface PersistOnOptions {
  regionCode: string;
  targetTimezone: string;
  /** 目标地区对应的 Windows tzutil 时区 ID，用于同步切换系统时区 */
  targetWinTimezone: string;
  targetLang: string;
  targetLcAll: string;
}

// ── persist on ──

export async function persistOnFlow(
  opts: PersistOnOptions,
  onEvent: EventConsumer,
): Promise<void> {
  const envKeys = ["TZ", "LANG", "LC_ALL"];

  // 步骤 1：备份
  onEvent({ type: "step-start", stepId: "backup", name: "创建环境变量备份" });
  let backup: BackupData;
  try {
    backup = createBackup(envKeys);
    onEvent({ type: "step-ok", stepId: "backup" });
  } catch (err) {
    onEvent({ type: "step-fail", stepId: "backup", error: String(err) });
    onEvent({ type: "summary", ok: 0, fail: 1, rolledBack: false, fatal: true });
    return;
  }

  // 旧备份缺失系统时区字段时，在任何改动前补写当前值
  if (backup.previousSystemTimezone === undefined) {
    try {
      const sysTz = getSystemTimezone();
      patchBackupSystemTimezone(sysTz);
      backup.previousSystemTimezone = sysTz;
    } catch {
      // tzutil 读取失败：不阻断主流程，后续切换步骤会自行报错
    }
  }

  // 旧备份缺失浏览器策略快照时，在任何改动前补写当前值（ADR-0003）
  if (backup.previousBrowserPolicies === undefined) {
    try {
      const policies = snapshotPolicies();
      patchBackupBrowserPolicies(policies);
      backup.previousBrowserPolicies = policies;
    } catch {
      // 策略快照失败：后续写入步骤会自行报错
    }
  }

  // 步骤 2-N：逐个设置环境变量
  const steps = [
    { key: "TZ",     value: opts.targetTimezone, stepId: "tz",   name: "设置时区 TZ" },
    { key: "LANG",   value: opts.targetLang,     stepId: "lang", name: "设置语言 LANG" },
    { key: "LC_ALL", value: opts.targetLcAll,    stepId: "lc",   name: "设置 LC_ALL" },
  ];

  const changedKeys: string[] = [];

  for (const step of steps) {
    const oldValue = getEnvVar(step.key) ?? "(未设置)";
    onEvent({
      type: "step-start",
      stepId: step.stepId,
      name: step.name,
      oldValue,
      newValue: step.value,
    });
    try {
      setEnvVar(step.key, step.value);
      changedKeys.push(step.key);
      onEvent({ type: "step-ok", stepId: step.stepId });
    } catch (err) {
      onEvent({ type: "step-fail", stepId: step.stepId, error: String(err) });
      // 回滚：只回滚已成功修改过的键
      const rollbackOk = await rollbackFlow(changedKeys, backup, onEvent);
      if (rollbackOk) {
        onEvent({ type: "summary", ok: changedKeys.length, fail: 1, rolledBack: true });
      } else {
        // 回滚失败：如实上报 fatal，备份文件保留供手动检查（不在此处删除）
        onEvent({ type: "summary", ok: changedKeys.length, fail: 1, rolledBack: false, fatal: true });
      }
      return;
    }
  }

  let okCount = steps.length;
  let failCount = 0;

  // 步骤 N+1：写入浏览器策略（Chrome/Edge HKCU，需重启浏览器生效，ADR-0003）
  const targets = targetPolicies(opts.targetLang);
  const slotsToWrite = POLICY_SLOTS.filter(slot => {
    const key = slotKey(slot);
    return backup.previousBrowserPolicies?.[key] !== targets[key];
  });

  if (slotsToWrite.length > 0) {
    const accept = targets[`${POLICY_SLOTS[0].browser}/AcceptLanguage`];
    onEvent({
      type: "step-start",
      stepId: "browser-policy",
      name: "写入浏览器策略（Chrome/Edge）",
      oldValue: `${slotsToWrite.length} 项待写入`,
      newValue: `AcceptLanguage=${accept}, WebRTC=disable_non_proxied_udp`,
    });
    const writtenKeys: string[] = [];
    try {
      for (const slot of slotsToWrite) {
        const key = slotKey(slot);
        setPolicy(slot.browser, slot.name, targets[key]);
        writtenKeys.push(key);
      }
      okCount++;
      onEvent({ type: "step-ok", stepId: "browser-policy" });
      // 策略需重启浏览器才生效：推送提示事件，附运行中浏览器（探测失败降级为空 → 普通样式）
      let running: string[] = [];
      try {
        running = detectRunningBrowsers();
      } catch {
        // 探测失败不阻断修复流
      }
      onEvent({ type: "browser-hint", running });
    } catch (err) {
      const errText = String(err);
      const accessDenied = /Access is denied|拒绝访问/i.test(errText);
      // 尽力还原已写入的策略（可能同样被拒，属预期内）
      restoreBrowserPoliciesBestEffort(writtenKeys, backup, onEvent);
      if (accessDenied) {
        // 权限受限（如 HKCU\Software\Policies ACL 加固）：降级不阻断，
        // 环境变量与系统时区继续执行；备份已含策略快照，off 不受影响
        onEvent({
          type: "step-fail",
          stepId: "browser-policy",
          error: `浏览器策略写入被拒：请以管理员权限运行 cc-fix 后重试（${errText}）`,
        });
        failCount++;
      } else {
        // 非权限错误：维持严格回滚语义
        onEvent({ type: "step-fail", stepId: "browser-policy", error: errText });
        const rollbackOk = await rollbackFlow(changedKeys, backup, onEvent);
        if (rollbackOk) {
          onEvent({ type: "summary", ok: changedKeys.length, fail: 1, rolledBack: true });
        } else {
          onEvent({ type: "summary", ok: changedKeys.length, fail: 1, rolledBack: false, fatal: true });
        }
        return;
      }
    }
  }

  // 步骤 N+2：切换 Windows 系统时区（浏览器指纹检测读物理时区，不读 TZ 环境变量）
  let currentSysTz: string;
  try {
    currentSysTz = getSystemTimezone();
  } catch (err) {
    onEvent({ type: "step-start", stepId: "sys-tz", name: "切换系统时区" });
    onEvent({ type: "step-fail", stepId: "sys-tz", error: String(err) });
    const policiesOk = restoreBrowserPoliciesBestEffort(
      slotsToWrite.map(slotKey), backup, onEvent,
    );
    const rollbackOk = await rollbackFlow(changedKeys, backup, onEvent);
    if (policiesOk && rollbackOk) {
      onEvent({ type: "summary", ok: changedKeys.length, fail: 1, rolledBack: true });
    } else {
      onEvent({ type: "summary", ok: changedKeys.length, fail: 1, rolledBack: false, fatal: true });
    }
    return;
  }

  if (currentSysTz !== opts.targetWinTimezone) {
    onEvent({
      type: "step-start",
      stepId: "sys-tz",
      name: "切换系统时区",
      oldValue: currentSysTz,
      newValue: opts.targetWinTimezone,
    });
    try {
      setSystemTimezone(opts.targetWinTimezone);
      okCount++;
      onEvent({ type: "step-ok", stepId: "sys-tz" });
    } catch (err) {
      onEvent({ type: "step-fail", stepId: "sys-tz", error: String(err) });
      // 系统时区尚未改动，需还原浏览器策略并回滚环境变量
      const policiesOk = restoreBrowserPoliciesBestEffort(
        slotsToWrite.map(slotKey), backup, onEvent,
      );
      const rollbackOk = await rollbackFlow(changedKeys, backup, onEvent);
      if (policiesOk && rollbackOk) {
        onEvent({ type: "summary", ok: changedKeys.length, fail: 1, rolledBack: true });
      } else {
        onEvent({ type: "summary", ok: changedKeys.length, fail: 1, rolledBack: false, fatal: true });
      }
      return;
    }
  }

  onEvent({ type: "summary", ok: okCount, fail: failCount, rolledBack: false });
}

// ── persist off ──

export async function persistOffFlow(onEvent: EventConsumer): Promise<void> {
  const status = getPersistStatus();
  if (!status.enabled || !status.backup) {
    onEvent({ type: "step-fail", stepId: "check", error: "持久化未开启" });
    onEvent({ type: "summary", ok: 0, fail: 1, rolledBack: false, fatal: true });
    return;
  }

  const backup = status.backup;
  const keys = Object.keys(backup.previous);
  let okCount = 0;

  for (const key of keys) {
    const oldValue = getEnvVar(key) ?? "(未设置)";
    const newValue = backup.previous[key] ?? "(删除)";
    onEvent({
      type: "step-start",
      stepId: `restore-${key}`,
      name: `恢复 ${key}`,
      oldValue,
      newValue,
    });
    try {
      if (backup.previous[key] === null) {
        deleteEnvVar(key);
      } else {
        setEnvVar(key, backup.previous[key]!);
      }
      okCount++;
      onEvent({ type: "step-ok", stepId: `restore-${key}` });
    } catch (err) {
      onEvent({ type: "step-fail", stepId: `restore-${key}`, error: String(err) });
      onEvent({ type: "summary", ok: okCount, fail: 1, rolledBack: false, fatal: true });
      return;
    }
  }

  // 恢复 Windows 系统时区（旧备份可能没有该字段，跳过）
  if (backup.previousSystemTimezone) {
    let currentSysTz: string | null = null;
    try {
      currentSysTz = getSystemTimezone();
    } catch {
      // 读取失败不阻断，直接尝试恢复
    }
    if (currentSysTz !== backup.previousSystemTimezone) {
      onEvent({
        type: "step-start",
        stepId: "restore-sys-tz",
        name: "恢复系统时区",
        oldValue: currentSysTz ?? "(未知)",
        newValue: backup.previousSystemTimezone,
      });
      try {
        setSystemTimezone(backup.previousSystemTimezone);
        okCount++;
        onEvent({ type: "step-ok", stepId: "restore-sys-tz" });
      } catch (err) {
        onEvent({ type: "step-fail", stepId: "restore-sys-tz", error: String(err) });
        // 保留备份文件供重试，不进入删备份步骤
        onEvent({ type: "summary", ok: okCount, fail: 1, rolledBack: false, fatal: true });
        return;
      }
    }
  }

  // 还原浏览器策略（旧备份可能没有该字段，跳过；ADR-0003）
  // 只还原当前值与快照不一致的槽位：降级运行（策略从未写入）时自动跳过，
  // 避免无权限环境下因无意义写入阻断 off 流程
  if (backup.previousBrowserPolicies) {
    const browsers = [...new Set(POLICY_SLOTS.map(s => s.browser))];
    for (const browser of browsers) {
      const slots = POLICY_SLOTS.filter(s => {
        if (s.browser !== browser) return false;
        const original = backup.previousBrowserPolicies![slotKey(s)];
        return getPolicy(s.browser, s.name) !== (original ?? null);
      });
      if (slots.length === 0) continue;

      const oldValues = slots
        .map(s => getPolicy(s.browser, s.name) ?? "(未设置)")
        .join(", ");
      const newValues = slots
        .map(s => backup.previousBrowserPolicies![slotKey(s)] ?? "(删除)")
        .join(", ");
      onEvent({
        type: "step-start",
        stepId: `restore-browser-policy-${browser}`,
        name: `还原浏览器策略（${browser === "chrome" ? "Chrome" : "Edge"}）`,
        oldValue: oldValues,
        newValue: newValues,
      });
      try {
        for (const slot of slots) {
          const original = backup.previousBrowserPolicies[slotKey(slot)];
          if (original === null || original === undefined) {
            deletePolicy(slot.browser, slot.name);
          } else {
            setPolicy(slot.browser, slot.name, original);
          }
        }
        okCount++;
        onEvent({ type: "step-ok", stepId: `restore-browser-policy-${browser}` });
      } catch (err) {
        onEvent({ type: "step-fail", stepId: `restore-browser-policy-${browser}`, error: String(err) });
        // 保留备份文件供重试（可能需管理员权限），不进入删备份步骤
        onEvent({ type: "summary", ok: okCount, fail: 1, rolledBack: false, fatal: true });
        return;
      }
    }
  }

  // 删除备份文件
  onEvent({ type: "step-start", stepId: "delete-backup", name: "删除备份文件" });
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      fs.unlinkSync(BACKUP_FILE);
    }
    okCount++;
    onEvent({ type: "step-ok", stepId: "delete-backup" });
  } catch (err) {
    onEvent({ type: "step-fail", stepId: "delete-backup", error: String(err) });
    onEvent({ type: "summary", ok: okCount, fail: 1, rolledBack: false, fatal: true });
    return;
  }

  onEvent({ type: "summary", ok: okCount, fail: 0, rolledBack: false });
}

// ── 内部辅助：浏览器策略尽力还原 ──

// 将 slotKeys 对应的策略还原为备份快照中的原值；逐项尽力执行，全部成功返回 true
function restoreBrowserPoliciesBestEffort(
  slotKeys: string[],
  backup: BackupData,
  onEvent: EventConsumer,
): boolean {
  const snapshot = backup.previousBrowserPolicies;
  if (!snapshot || slotKeys.length === 0) return true;

  let allOk = true;
  for (const key of slotKeys) {
    const slot = POLICY_SLOTS.find(s => slotKey(s) === key);
    if (!slot) continue;
    const original = snapshot[key];
    onEvent({
      type: "step-start",
      stepId: `rollback-policy-${key}`,
      name: `还原策略 ${key}`,
      rollback: true,
    });
    try {
      if (original === null || original === undefined) {
        deletePolicy(slot.browser, slot.name);
      } else {
        setPolicy(slot.browser, slot.name, original);
      }
      onEvent({ type: "step-ok", stepId: `rollback-policy-${key}`, rollback: true });
    } catch (err) {
      onEvent({ type: "step-fail", stepId: `rollback-policy-${key}`, error: String(err), rollback: true });
      allOk = false;
    }
  }
  return allOk;
}

// ── 内部辅助：回滚 ──

// 返回 true 表示所有键均回滚成功；任一失败返回 false（备份文件保留供手动检查）
async function rollbackFlow(
  changedKeys: string[],
  backup: BackupData,
  onEvent: EventConsumer,
): Promise<boolean> {
  let allOk = true;
  for (const key of changedKeys) {
    const oldValue = getEnvVar(key) ?? "(未设置)";
    const newValue = backup.previous[key] ?? "(删除)";
    onEvent({
      type: "step-start",
      stepId: `rollback-${key}`,
      name: `回滚 ${key}`,
      oldValue,
      newValue,
      rollback: true,
    });
    try {
      if (backup.previous[key] === null) {
        deleteEnvVar(key);
      } else {
        setEnvVar(key, backup.previous[key]!);
      }
      onEvent({ type: "step-ok", stepId: `rollback-${key}`, rollback: true });
    } catch (err) {
      onEvent({ type: "step-fail", stepId: `rollback-${key}`, error: String(err), rollback: true });
      // fatal：回滚失败，继续尝试其余键，最终由调用方上报并保留备份
      allOk = false;
    }
  }
  return allOk;
}
