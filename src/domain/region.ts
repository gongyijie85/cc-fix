export const REGION_CODES = ["us", "eu", "jp", "sg"] as const;

export type RegionCode = (typeof REGION_CODES)[number];
export type RegionSource = "explicit" | "active" | "preferred" | "initial_default";

export interface ResolvedRegion {
  code: RegionCode;
  source: RegionSource;
}

export type RegionInputSource = Exclude<RegionSource, "initial_default">;

export interface RegionResolutionInput {
  explicit?: unknown;
  active?: unknown;
  preferred?: unknown;
}

export class RegionResolutionError extends Error {
  readonly code = "INVALID_REGION" as const;
  readonly validRegions = REGION_CODES;

  constructor(
    readonly source: RegionInputSource,
    readonly value: unknown,
  ) {
    super(`Invalid ${source} region; expected one of: ${REGION_CODES.join(", ")}`);
    this.name = "RegionResolutionError";
  }
}

export function isRegionCode(value: unknown): value is RegionCode {
  return typeof value === "string" && (REGION_CODES as readonly string[]).includes(value);
}

export function parseRegionCode(value: unknown, source: RegionInputSource): RegionCode {
  if (!isRegionCode(value)) {
    throw new RegionResolutionError(source, value);
  }

  return value;
}

function isPresent(value: unknown): boolean {
  return value !== undefined;
}

export function resolveRegion(input: RegionResolutionInput): ResolvedRegion {
  if (isPresent(input.explicit)) {
    return { code: parseRegionCode(input.explicit, "explicit"), source: "explicit" };
  }

  if (isPresent(input.active)) {
    return { code: parseRegionCode(input.active, "active"), source: "active" };
  }

  if (isPresent(input.preferred)) {
    return { code: parseRegionCode(input.preferred, "preferred"), source: "preferred" };
  }

  return { code: "us", source: "initial_default" };
}
