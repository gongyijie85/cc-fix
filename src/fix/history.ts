// 操作日志 — 追加式 JSONL，回答"我上次干了什么"（ADR-0002）

import fs from "node:fs";
import path from "node:path";

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

function getHistoryFile(): string {
  const appdata = process.env.APPDATA || path.join(process.env.HOME || "", ".config");
  return path.join(appdata, "cc-fix", "history.jsonl");
}

export function appendHistory(entry: HistoryEntry): void {
  try {
    const file = getHistoryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // 日志写入失败不阻断主流程
  }
}

// 返回最近 limit 条，最新在前；损坏的行跳过
export function readHistory(limit = 10): HistoryEntry[] {
  let content: string;
  try {
    content = fs.readFileSync(getHistoryFile(), "utf-8");
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

export function recordFixSummary(
  action: "persist-on" | "persist-off",
  summary: { ok: number; fail: number; rolledBack?: boolean; fatal?: boolean },
): void {
  appendHistory({
    timestamp: new Date().toISOString(),
    action,
    ok: summary.ok,
    fail: summary.fail,
    ...(summary.rolledBack ? { rolledBack: true } : {}),
    ...(summary.fatal ? { fatal: true } : {}),
  });
}

export function recordCheck(score: number): void {
  appendHistory({
    timestamp: new Date().toISOString(),
    action: "check",
    score,
  });
}
