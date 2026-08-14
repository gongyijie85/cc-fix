// 操作日志 — 追加式 JSONL，回答"我上次干了什么"（ADR-0002）

import fs from "node:fs/promises";
import path from "node:path";
import { defaultPersistRoot } from "../state/paths.js";

export type HistoryAction = "persist-on" | "persist-off" | "check";

export type HistoryEntry = {
  timestamp: string;
  action: HistoryAction;
  ok?: number;
  fail?: number;
  rolledBack?: boolean;
  fatal?: boolean;
  score?: number;
};

/** 日志文件路径；root 可注入（测试传临时目录），默认唯一推导点 state/paths.defaultPersistRoot。 */
export function historyFilePath(root: string = defaultPersistRoot(process.env)): string {
  return path.join(root, "history.jsonl");
}

export async function appendHistory(entry: HistoryEntry, root?: string): Promise<void> {
  try {
    const file = historyFilePath(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // 日志写入失败不阻断主流程
  }
}

// 返回最近 limit 条，最新在前；损坏的行跳过
export async function readHistory(limit = 10, root?: string): Promise<HistoryEntry[]> {
  let content: string;
  try {
    content = await fs.readFile(historyFilePath(root), "utf-8");
  } catch {
    return [];
  }

  const entries: HistoryEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as HistoryEntry;
      if (parsed && typeof parsed.timestamp === "string" && typeof parsed.action === "string") {
        entries.push(parsed);
      }
    } catch {
      // 损坏的单行跳过，不影响其余条目
    }
  }
  return entries.slice(-limit).reverse();
}

// ── 便捷记录函数 ──

export async function recordFixSummary(
  action: "persist-on" | "persist-off",
  summary: { ok: number; fail: number; rolledBack?: boolean; fatal?: boolean },
  root?: string,
): Promise<void> {
  await appendHistory({
    timestamp: new Date().toISOString(),
    action,
    ok: summary.ok,
    fail: summary.fail,
    ...(summary.rolledBack ? { rolledBack: true } : {}),
    ...(summary.fatal ? { fatal: true } : {}),
  }, root);
}

export async function recordCheck(score: number, root?: string): Promise<void> {
  await appendHistory({
    timestamp: new Date().toISOString(),
    action: "check",
    score,
  }, root);
}
