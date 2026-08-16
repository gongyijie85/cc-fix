// 操作日志 schema（T14）：版本化、追加式；v1 旧记录可读并规范化为 v2。
// 领域词汇见 CONTEXT.md「操作日志」：快照负责可恢复，日志负责可追溯（ADR-0002）。
import type { ProtectionHealth, ProtectedMode } from "../domain/protection.js";
import type { RegionCode, RegionSource } from "../domain/region.js";

export const HISTORY_SCHEMA_VERSION = 2;

export type HistoryAction =
  | "persist-on"
  | "persist-off"
  | "persist-recover"
  | "check"
  | "font-remove"
  | "font-restore";

export type HistoryOutcome =
  | "ok"
  | "noop"
  | "degraded"
  | "compensated"
  | "recovery_required"
  | "failed";

export type HistoryTarget = Readonly<{ mode: ProtectedMode; region: RegionCode }>;

export type HistoryRecordV2 = Readonly<{
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  timestamp: string;
  action: HistoryAction;
  outcome: HistoryOutcome;
  /** 请求事实：失败请求也保留用户请求的目标。 */
  requested?: HistoryTarget | null;
  /** 最终事实：反映仍提交的目标，而非失败请求的目标。 */
  committed?: HistoryTarget | null;
  resolvedRegion?: Readonly<{ code: RegionCode; source: RegionSource }> | null;
  preferredRegion?: RegionCode;
  health?: ProtectionHealth;
  transactionId?: string | null;
  counts?: Readonly<{ ok: number; fail: number }>;
  rolledBack?: boolean;
  noOp?: boolean;
  score?: number;
}>;

/** 旧版（v1）追加式条目：无 schemaVersion，字段为 action/ok/fail/rolledBack/fatal/score。 */
export type LegacyHistoryEntry = Readonly<{
  timestamp: string;
  action: string;
  ok?: number;
  fail?: number;
  rolledBack?: boolean;
  fatal?: boolean;
  score?: number;
}>;

const ACTIONS: ReadonlySet<string> = new Set<HistoryAction>([
  "persist-on",
  "persist-off",
  "persist-recover",
  "check",
  "font-remove",
  "font-restore",
]);

const OUTCOMES: ReadonlySet<string> = new Set<HistoryOutcome>([
  "ok",
  "noop",
  "degraded",
  "compensated",
  "recovery_required",
  "failed",
]);

const REGIONS: ReadonlySet<string> = new Set<string>(["us", "eu", "jp", "sg"]);

function isTarget(value: unknown): value is HistoryTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    (target.mode === "standard" || target.mode === "deep") &&
    typeof target.region === "string" &&
    REGIONS.has(target.region)
  );
}

function isResolvedRegion(value: unknown): value is NonNullable<HistoryRecordV2["resolvedRegion"]> {
  if (typeof value !== "object" || value === null) return false;
  const region = value as Record<string, unknown>;
  return (
    typeof region.code === "string" &&
    REGIONS.has(region.code) &&
    (region.source === "explicit" ||
      region.source === "active" ||
      region.source === "preferred" ||
      region.source === "initial_default")
  );
}

export function isHistoryRecordV2(value: unknown): value is HistoryRecordV2 {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== HISTORY_SCHEMA_VERSION) return false;
  if (typeof record.timestamp !== "string" || typeof record.action !== "string") return false;
  if (!ACTIONS.has(record.action) || !OUTCOMES.has(record.outcome as string)) return false;
  if (record.requested !== undefined && record.requested !== null && !isTarget(record.requested)) return false;
  if (record.committed !== undefined && record.committed !== null && !isTarget(record.committed)) return false;
  if (
    record.resolvedRegion !== undefined &&
    record.resolvedRegion !== null &&
    !isResolvedRegion(record.resolvedRegion)
  ) return false;
  if (record.preferredRegion !== undefined && (typeof record.preferredRegion !== "string" || !REGIONS.has(record.preferredRegion))) return false;
  if (record.health !== undefined && !["healthy", "degraded", "recovery_required"].includes(record.health as string)) return false;
  if (record.transactionId !== undefined && record.transactionId !== null && typeof record.transactionId !== "string") return false;
  if (record.counts !== undefined) {
    const counts = record.counts as Record<string, unknown>;
    if (typeof counts !== "object" || counts === null || typeof counts.ok !== "number" || typeof counts.fail !== "number") return false;
  }
  if (record.score !== undefined && typeof record.score !== "number") return false;
  return true;
}

function legacyOutcome(entry: LegacyHistoryEntry): HistoryOutcome {
  if (entry.fatal === true) return "failed";
  if (entry.rolledBack === true) return "compensated";
  if ((entry.fail ?? 0) > 0) return "failed";
  if ((entry.ok ?? 0) > 0) return "ok";
  return "noop";
}

/** v1 → v2 规范化：旧记录无 schemaVersion，按旧字段推导 outcome 与 counts。 */
export function normalizeLegacyEntry(entry: LegacyHistoryEntry): HistoryRecordV2 {
  const action = ACTIONS.has(entry.action) ? (entry.action as HistoryAction) : ("check" as HistoryAction);
  const counts = entry.ok !== undefined || entry.fail !== undefined
    ? { ok: entry.ok ?? 0, fail: entry.fail ?? 0 }
    : undefined;
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    timestamp: entry.timestamp,
    action,
    outcome: legacyOutcome(entry),
    ...(counts === undefined ? {} : { counts }),
    ...(entry.rolledBack === true ? { rolledBack: true } : {}),
    ...(entry.score !== undefined ? { score: entry.score } : {}),
  };
}

/** 解析单行：v2 直接校验；v1 规范化；损坏/未知形状返回 null（读侧跳过，不阻断其余）。 */
export function parseHistoryLine(line: string): HistoryRecordV2 | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion === HISTORY_SCHEMA_VERSION) {
    return isHistoryRecordV2(candidate) ? candidate : null;
  }
  if (candidate.schemaVersion === undefined) {
    if (typeof candidate.timestamp !== "string" || typeof candidate.action !== "string") return null;
    return normalizeLegacyEntry(candidate as unknown as LegacyHistoryEntry);
  }
  return null;
}

export function serializeHistoryRecord(record: HistoryRecordV2): string {
  return JSON.stringify(record);
}
