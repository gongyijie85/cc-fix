import { describe, expect, it } from "vitest";
import {
  CliFailure,
  EXIT_BUSY,
  EXIT_COMPENSATED,
  EXIT_DEGRADED,
  EXIT_INCOMPLETE_RECOVERY,
  EXIT_INTERNAL,
  EXIT_INVALID_INPUT,
  EXIT_OK,
  EXIT_RECOVERY_REQUIRED,
  EXIT_STATE_INVALID,
  classifyError,
  exitCodeForProtectOutcome,
  exitCodeForRecoveryOutcome,
  exitCodeForRestoreOutcome,
} from "./exit-codes.js";
import { RegionResolutionError } from "../domain/region.js";
import { ProtectionRequestError } from "../domain/protection.js";
import { MutationBusyError, MutationRecoveryRequiredError } from "../state/mutation-coordinator.js";
import { PersistApplicationError } from "../persist/transaction/index.js";
import { PersistRuntimeError } from "../persist/runtime.js";
import { RepositoryError } from "../state/repository.js";

describe("CLI stable exit codes (spec table)", () => {
  it("maps invalid region to 10/INVALID_REGION", () => {
    const failure = classifyError(new RegionResolutionError("explicit", "cn"));
    expect(failure).toEqual({ exitCode: EXIT_INVALID_INPUT, errorId: "INVALID_REGION" });
  });

  it("maps invalid protection level to 10/INVALID_PROTECTION_LEVEL", () => {
    const failure = classifyError(new ProtectionRequestError("INVALID_PROTECTION_LEVEL", "ultra", false));
    expect(failure).toEqual({ exitCode: EXIT_INVALID_INPUT, errorId: "INVALID_PROTECTION_LEVEL" });
  });

  it("maps conflicting --deep/--level to 10/CONFLICTING_PROTECTION_LEVEL", () => {
    const failure = classifyError(new ProtectionRequestError("CONFLICTING_PROTECTION_LEVEL", "standard", true));
    expect(failure).toEqual({ exitCode: EXIT_INVALID_INPUT, errorId: "CONFLICTING_PROTECTION_LEVEL" });
  });

  it("maps live-lock busy to 20/BUSY", () => {
    const failure = classifyError(new MutationBusyError({ owner: "pid-1" }));
    expect(failure).toEqual({ exitCode: EXIT_BUSY, errorId: "BUSY" });
  });

  it("maps recovery_required blockers to 21/RECOVERY_REQUIRED", () => {
    expect(classifyError(new MutationRecoveryRequiredError({ owner: "pid-1" }))).toEqual({
      exitCode: EXIT_RECOVERY_REQUIRED,
      errorId: "RECOVERY_REQUIRED",
    });
    expect(classifyError(new PersistApplicationError("RECOVERY_REQUIRED", "must recover first"))).toEqual({
      exitCode: EXIT_RECOVERY_REQUIRED,
      errorId: "RECOVERY_REQUIRED",
    });
    expect(classifyError(new PersistRuntimeError("MIGRATION_RECOVERY_REQUIRED", "legacy state needs recovery"))).toEqual({
      exitCode: EXIT_RECOVERY_REQUIRED,
      errorId: "RECOVERY_REQUIRED",
    });
  });

  it("maps state/backup/schema validation failures to 24/STATE_INVALID", () => {
    for (const code of ["INVALID_STATE", "INVALID_BACKUP", "STATE_MISSING", "REVISION_MISMATCH", "BACKUP_IDENTITY_MISMATCH"]) {
      const failure = classifyError(new RepositoryError(code as never, "validation failed"));
      expect(failure).toEqual({ exitCode: EXIT_STATE_INVALID, errorId: "STATE_INVALID" });
    }
  });

  it("maps migration state-validation failures to 24/STATE_INVALID", () => {
    for (const reason of ["state_read_failed", "legacy_corrupt_json", "legacy_unknown_schema", "legacy_invalid_shape"]) {
      const failure = classifyError(new PersistRuntimeError("INITIALIZATION_FAILED", "init failed", {
        kind: "failed",
        reason: reason as never,
        committedTarget: null,
        stateWritten: false,
      }));
      expect(failure).toEqual({ exitCode: EXIT_STATE_INVALID, errorId: "STATE_INVALID" });
    }
  });

  it("maps non-validation migration failures to 30/INTERNAL", () => {
    const failure = classifyError(new PersistRuntimeError("INITIALIZATION_FAILED", "init failed", {
      kind: "failed",
      reason: "lock_failed",
      committedTarget: null,
      stateWritten: false,
    }));
    expect(failure).toEqual({ exitCode: EXIT_INTERNAL, errorId: "INTERNAL" });
  });

  it("maps IO/lock infrastructure errors to 30/INTERNAL", () => {
    for (const code of ["IO_FAILED", "LOCK_REQUIRED", "DELETE_FAILED"]) {
      const failure = classifyError(new RepositoryError(code as never, "infrastructure failed"));
      expect(failure).toEqual({ exitCode: EXIT_INTERNAL, errorId: "INTERNAL" });
    }
    expect(classifyError(new PersistRuntimeError("INITIALIZATION_FAILED", "init failed"))).toEqual({
      exitCode: EXIT_INTERNAL,
      errorId: "INTERNAL",
    });
    expect(classifyError(new Error("anything else"))).toEqual({ exitCode: EXIT_INTERNAL, errorId: "INTERNAL" });
  });

  it("maps CliFailure verbatim", () => {
    const failure = new CliFailure(EXIT_INCOMPLETE_RECOVERY, "INCOMPLETE_RECOVERY", "restore incomplete");
    expect(classifyError(failure)).toEqual({ exitCode: EXIT_INCOMPLETE_RECOVERY, errorId: "INCOMPLETE_RECOVERY" });
  });

  it("maps protect outcomes deterministically (0/0/2/22/23)", () => {
    expect(exitCodeForProtectOutcome("noop")).toBe(EXIT_OK);
    expect(exitCodeForProtectOutcome("committable")).toBe(EXIT_OK);
    expect(exitCodeForProtectOutcome("degraded")).toBe(EXIT_DEGRADED);
    expect(exitCodeForProtectOutcome("compensated")).toBe(EXIT_COMPENSATED);
    expect(exitCodeForProtectOutcome("recovery_required")).toBe(EXIT_INCOMPLETE_RECOVERY);
  });

  it("maps restore/recover outcomes deterministically (0/23)", () => {
    expect(exitCodeForRestoreOutcome("noop")).toBe(EXIT_OK);
    expect(exitCodeForRestoreOutcome("restored")).toBe(EXIT_OK);
    expect(exitCodeForRestoreOutcome("recovery_required")).toBe(EXIT_INCOMPLETE_RECOVERY);
    expect(exitCodeForRecoveryOutcome("noop")).toBe(EXIT_OK);
    expect(exitCodeForRecoveryOutcome("recovered")).toBe(EXIT_OK);
    expect(exitCodeForRecoveryOutcome("recovery_required")).toBe(EXIT_INCOMPLETE_RECOVERY);
  });
});
