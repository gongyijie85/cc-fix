// CLI 稳定退出码契约（规格 windows-productization-v0.2 §CLI 稳定退出码）
//
// | Code | Meaning |
// |---:|---|
// | 0  | healthy success 或 no-op |
// | 2  | protection target 已提交，但 health=degraded |
// | 10 | 非法参数、地区或冲突参数 |
// | 20 | 活事务/活锁导致 busy |
// | 21 | recovery_required，拒绝新转换 |
// | 22 | 操作失败但补偿已验证，旧 target 保持 |
// | 23 | 操作失败且补偿/恢复不完整 |
// | 24 | 状态、备份或 schema 校验失败 |
// | 30 | 启动/前置组件/内部不可分类错误 |

import { RegionResolutionError } from "../domain/region.js";
import { ProtectionRequestError } from "../domain/protection.js";
import { MutationBusyError, MutationRecoveryRequiredError } from "../state/mutation-coordinator.js";
import { PersistApplicationError } from "../persist/transaction/index.js";
import { PersistRuntimeError } from "../persist/runtime.js";
import { RepositoryError } from "../state/repository.js";

export const CLI_SCHEMA_VERSION = 1;

export const EXIT_OK = 0;
export const EXIT_DEGRADED = 2;
export const EXIT_INVALID_INPUT = 10;
export const EXIT_BUSY = 20;
export const EXIT_RECOVERY_REQUIRED = 21;
export const EXIT_COMPENSATED = 22;
export const EXIT_INCOMPLETE_RECOVERY = 23;
export const EXIT_STATE_INVALID = 24;
export const EXIT_INTERNAL = 30;

/** 稳定 error id：JSON 输出与人类输出共用同一分类。 */
export type CliErrorId =
  | "INVALID_REGION"
  | "INVALID_PROTECTION_LEVEL"
  | "CONFLICTING_PROTECTION_LEVEL"
  | "INVALID_COMMAND"
  | "BUSY"
  | "RECOVERY_REQUIRED"
  | "COMPENSATED"
  | "INCOMPLETE_RECOVERY"
  | "STATE_INVALID"
  | "INTERNAL";

export const EXIT_CODE_TABLE: Readonly<Record<number, string>> = Object.freeze({
  [EXIT_OK]: "healthy success 或 no-op",
  [EXIT_DEGRADED]: "protection target 已提交，但 health=degraded",
  [EXIT_INVALID_INPUT]: "非法参数、地区或冲突参数",
  [EXIT_BUSY]: "活事务/活锁导致 busy",
  [EXIT_RECOVERY_REQUIRED]: "recovery_required，拒绝新转换",
  [EXIT_COMPENSATED]: "操作失败但补偿已验证，旧 target 保持",
  [EXIT_INCOMPLETE_RECOVERY]: "操作失败且补偿/恢复不完整",
  [EXIT_STATE_INVALID]: "状态、备份或 schema 校验失败",
  [EXIT_INTERNAL]: "启动/前置组件/内部不可分类错误",
});

/** 供 CLI 层抛出的已分类失败；顶级 catch 只做机械映射。 */
export class CliFailure extends Error {
  constructor(
    readonly exitCode: number,
    readonly errorId: CliErrorId,
    message: string,
  ) {
    super(message);
    this.name = "CliFailure";
  }
}

/** Repository 错误码中属于"状态/备份/schema 校验失败"（24）的子集。 */
const STATE_VALIDATION_REPOSITORY_CODES = new Set([
  "INVALID_STATE",
  "INVALID_BACKUP",
  "STATE_MISSING",
  "STATE_ALREADY_EXISTS",
  "STATE_CORRUPT",
  "BACKUP_CORRUPT",
  "BACKUP_ALREADY_EXISTS",
  "BACKUP_MISSING",
  "REVISION_MISMATCH",
  "BACKUP_IDENTITY_MISMATCH",
  "RESTORE_PROOF_INVALID",
  "RESTORE_VERIFIER_REQUIRED",
]);

export interface ClassifiedFailure {
  exitCode: number;
  errorId: CliErrorId;
}

/** 把任意领域/基础设施错误映射为稳定退出码与 error id；无法分类一律 30。 */
export function classifyError(error: unknown): ClassifiedFailure {
  if (error instanceof CliFailure) {
    return { exitCode: error.exitCode, errorId: error.errorId };
  }
  if (error instanceof RegionResolutionError) {
    return { exitCode: EXIT_INVALID_INPUT, errorId: "INVALID_REGION" };
  }
  if (error instanceof ProtectionRequestError) {
    return error.code === "CONFLICTING_PROTECTION_LEVEL"
      ? { exitCode: EXIT_INVALID_INPUT, errorId: "CONFLICTING_PROTECTION_LEVEL" }
      : { exitCode: EXIT_INVALID_INPUT, errorId: "INVALID_PROTECTION_LEVEL" };
  }
  if (error instanceof MutationBusyError) {
    return { exitCode: EXIT_BUSY, errorId: "BUSY" };
  }
  if (error instanceof MutationRecoveryRequiredError) {
    return { exitCode: EXIT_RECOVERY_REQUIRED, errorId: "RECOVERY_REQUIRED" };
  }
  if (error instanceof PersistApplicationError) {
    if (error.code === "RECOVERY_REQUIRED") {
      return { exitCode: EXIT_RECOVERY_REQUIRED, errorId: "RECOVERY_REQUIRED" };
    }
    return { exitCode: EXIT_INTERNAL, errorId: "INTERNAL" };
  }
  if (error instanceof PersistRuntimeError) {
    if (error.code === "MIGRATION_RECOVERY_REQUIRED") {
      return { exitCode: EXIT_RECOVERY_REQUIRED, errorId: "RECOVERY_REQUIRED" };
    }
    if (
      error.code === "INITIALIZATION_FAILED" &&
      error.migration?.kind === "failed" &&
      (error.migration.reason === "state_read_failed" ||
        error.migration.reason === "legacy_corrupt_json" ||
        error.migration.reason === "legacy_unknown_schema" ||
        error.migration.reason === "legacy_invalid_shape")
    ) {
      return { exitCode: EXIT_STATE_INVALID, errorId: "STATE_INVALID" };
    }
    return { exitCode: EXIT_INTERNAL, errorId: "INTERNAL" };
  }
  if (error instanceof RepositoryError) {
    if (error.code === "RECOVERY_REQUIRED") {
      return { exitCode: EXIT_RECOVERY_REQUIRED, errorId: "RECOVERY_REQUIRED" };
    }
    return STATE_VALIDATION_REPOSITORY_CODES.has(error.code)
      ? { exitCode: EXIT_STATE_INVALID, errorId: "STATE_INVALID" }
      : { exitCode: EXIT_INTERNAL, errorId: "INTERNAL" };
  }
  return { exitCode: EXIT_INTERNAL, errorId: "INTERNAL" };
}

export type ProtectOutcomeKind = "noop" | "committable" | "degraded" | "compensated" | "recovery_required";
export type RestoreOutcomeKind = "noop" | "restored" | "recovery_required";
export type RecoveryOutcomeKind = "noop" | "recovered" | "recovery_required";

/** protect 事务结果的确定性退出码映射（规格表 0/2/22/23）。 */
export function exitCodeForProtectOutcome(kind: ProtectOutcomeKind): number {
  switch (kind) {
    case "noop":
    case "committable":
      return EXIT_OK;
    case "degraded":
      return EXIT_DEGRADED;
    case "compensated":
      return EXIT_COMPENSATED;
    case "recovery_required":
      return EXIT_INCOMPLETE_RECOVERY;
  }
}

/** restore 事务结果的确定性退出码映射（0/23）。 */
export function exitCodeForRestoreOutcome(kind: RestoreOutcomeKind): number {
  return kind === "recovery_required" ? EXIT_INCOMPLETE_RECOVERY : EXIT_OK;
}

/** recover 事务结果的确定性退出码映射（0/23）。 */
export function exitCodeForRecoveryOutcome(kind: RecoveryOutcomeKind): number {
  return kind === "recovery_required" ? EXIT_INCOMPLETE_RECOVERY : EXIT_OK;
}

export function errorIdForOutcome(
  kind: "noop" | "committable" | "degraded" | "compensated" | "recovery_required" | "restored" | "recovered",
): CliErrorId {
  switch (kind) {
    case "compensated":
      return "COMPENSATED";
    case "recovery_required":
      return "INCOMPLETE_RECOVERY";
    case "degraded":
      return "INTERNAL"; // 非错误：exit 2 但无 error id 语义
    default:
      return "INTERNAL";
  }
}
