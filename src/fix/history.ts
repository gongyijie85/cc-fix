// 操作日志门面（T14）——追加式 JSONL，回答"我上次干了什么"（ADR-0002）。
// 版本化 schema 与存储位于 src/history/；本模块保留历史调用点兼容并新增事务事实记录。
import { defaultPersistRoot } from "../state/paths.js";
import { TransactionJournalRepository } from "../state/journal.js";
import { statePaths } from "../state/paths.js";
import {
  HISTORY_SCHEMA_VERSION,
  normalizeLegacyEntry,
  type HistoryOutcome,
  type HistoryRecordV2,
  type HistoryTarget,
  type LegacyHistoryEntry,
} from "../history/schema.js";
import { appendHistoryRecord, readHistoryRecords } from "../history/store.js";

export {
  HISTORY_SCHEMA_VERSION,
  type HistoryAction,
  type HistoryOutcome,
  type HistoryRecordV2,
  type HistoryTarget,
} from "../history/schema.js";
export { historyFilePath } from "../history/store.js";

/** 追加记录；旧版形状（v1，无 schemaVersion）自动规范化。写失败返回 false（观测降级）。 */
export async function appendHistory(entry: HistoryRecordV2 | LegacyHistoryEntry, root?: string): Promise<boolean> {
  const record: HistoryRecordV2 = "schemaVersion" in entry
    ? entry as HistoryRecordV2
    : normalizeLegacyEntry(entry as LegacyHistoryEntry);
  return appendHistoryRecord(record, root);
}

/** 读取最近 limit 条（最新在前）；损坏行跳过。 */
export async function readHistory(limit = 10, root?: string): Promise<HistoryRecordV2[]> {
  return readHistoryRecords(limit, root);
}

// ── 便捷记录函数 ──

/** 检测记录：仅评分（不涉及目标事实）。 */
export async function recordCheck(score: number, root?: string): Promise<boolean> {
  return appendHistoryRecord({
    schemaVersion: HISTORY_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    action: "check",
    outcome: "ok",
    score,
  }, root);
}

export type FixSummary = { ok: number; fail: number; rolledBack?: boolean; fatal?: boolean };

/** 修复摘要（GUI 兼容入口）：按旧字段推导 outcome。 */
export async function recordFixSummary(
  action: "persist-on" | "persist-off",
  summary: FixSummary,
  root?: string,
): Promise<boolean> {
  const outcome: HistoryOutcome = summary.fatal === true
    ? "failed"
    : summary.rolledBack === true
      ? "compensated"
      : summary.fail > 0
        ? "failed"
        : summary.ok > 0
          ? "ok"
          : "noop";
  return appendHistoryRecord({
    schemaVersion: HISTORY_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    action,
    outcome,
    counts: { ok: summary.ok, fail: summary.fail },
    ...(summary.rolledBack === true ? { rolledBack: true } : {}),
  }, root);
}

/** 字体操作记录。 */
export async function recordFontAction(action: "font-remove" | "font-restore", root?: string): Promise<boolean> {
  return appendHistoryRecord({
    schemaVersion: HISTORY_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    action,
    outcome: "ok",
  }, root);
}

export type PersistHistoryFacts = Readonly<{
  action: "persist-on" | "persist-off" | "persist-recover";
  outcome: HistoryOutcome;
  requested?: HistoryTarget | null;
  committed?: HistoryTarget | null;
  resolvedRegion?: HistoryRecordV2["resolvedRegion"];
  preferredRegion?: HistoryRecordV2["preferredRegion"];
  health?: HistoryRecordV2["health"];
  transactionId?: string | null;
  counts?: Readonly<{ ok: number; fail: number }>;
  rolledBack?: boolean;
  noOp?: boolean;
}>;

/**
 * 事务事实记录（T14）：请求事实与最终事实都保留，失败请求不覆盖仍提交的目标。
 * 未提供 transactionId 时尽力从事务日志读取；写失败返回 false（观测降级）。
 */
export async function recordPersistFacts(facts: PersistHistoryFacts, root?: string): Promise<boolean> {
  let transactionId = facts.transactionId;
  if (transactionId === undefined) {
    try {
      const stateRoot = root ?? defaultPersistRoot(process.env);
      const journal = await new TransactionJournalRepository(stateRoot, statePaths(stateRoot).journal).read();
      transactionId = journal?.transactionId ?? null;
    } catch {
      transactionId = null;
    }
  }
  return appendHistoryRecord({
    schemaVersion: HISTORY_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    action: facts.action,
    outcome: facts.outcome,
    ...(facts.requested !== undefined ? { requested: facts.requested } : {}),
    ...(facts.committed !== undefined ? { committed: facts.committed } : {}),
    ...(facts.resolvedRegion !== undefined ? { resolvedRegion: facts.resolvedRegion } : {}),
    ...(facts.preferredRegion !== undefined ? { preferredRegion: facts.preferredRegion } : {}),
    ...(facts.health !== undefined ? { health: facts.health } : {}),
    ...(transactionId !== null ? { transactionId } : {}),
    ...(facts.counts !== undefined ? { counts: facts.counts } : {}),
    ...(facts.rolledBack === true ? { rolledBack: true } : {}),
    ...(facts.noOp === true ? { noOp: true } : {}),
  }, root);
}
