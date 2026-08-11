import type { RegionCode, ResolvedRegion } from "./region.js";

export const PROTECTION_MODES = ["daily", "standard", "deep"] as const;
export const PROTECTED_MODES = ["standard", "deep"] as const;
export const PROTECTION_HEALTH_VALUES = ["healthy", "degraded", "recovery_required"] as const;

export type ProtectionMode = (typeof PROTECTION_MODES)[number];
export type ProtectionHealth = (typeof PROTECTION_HEALTH_VALUES)[number];
export type ProtectedMode = Exclude<ProtectionMode, "daily">;

export interface ProtectionTarget {
  mode: ProtectedMode;
  region: RegionCode;
}

export interface ProtectionRequest {
  currentMode: ProtectionMode;
  resolvedRegion: ResolvedRegion;
  level?: unknown;
  deep?: boolean;
}

export type ProtectionRequestErrorCode =
  | "INVALID_PROTECTION_LEVEL"
  | "CONFLICTING_PROTECTION_LEVEL";

export class ProtectionRequestError extends Error {
  readonly validLevels = PROTECTED_MODES;

  constructor(
    readonly code: ProtectionRequestErrorCode,
    readonly level: unknown,
    readonly deep: boolean,
  ) {
    super(
      code === "CONFLICTING_PROTECTION_LEVEL"
        ? "--deep conflicts with --level standard"
        : `Invalid protection level; expected one of: ${PROTECTED_MODES.join(", ")}`,
    );
    this.name = "ProtectionRequestError";
  }
}

function parseProtectionLevel(level: unknown): ProtectedMode {
  if (level === "standard" || level === "deep") {
    return level;
  }

  throw new ProtectionRequestError("INVALID_PROTECTION_LEVEL", level, false);
}

export function resolveProtectionRequest(request: ProtectionRequest): ProtectionTarget {
  const deep = request.deep === true;
  const hasExplicitLevel = request.level !== undefined;
  const explicitLevel = hasExplicitLevel ? parseProtectionLevel(request.level) : undefined;

  if (deep && explicitLevel === "standard") {
    throw new ProtectionRequestError("CONFLICTING_PROTECTION_LEVEL", request.level, true);
  }

  const mode = deep
    ? "deep"
    : explicitLevel ?? (request.currentMode === "daily" ? "standard" : request.currentMode);

  return { mode, region: request.resolvedRegion.code };
}
