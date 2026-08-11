import { describe, expect, it } from "vitest";
import { REGION_CODES, type RegionCode } from "./region.js";
import {
  ProtectionRequestError,
  resolveProtectionRequest,
  type ProtectionMode,
  type ProtectedMode,
} from "./protection.js";

const CURRENT_MODE_CASES: ReadonlyArray<{
  currentMode: ProtectionMode;
  expectedMode: ProtectedMode;
}> = [
  { currentMode: "daily", expectedMode: "standard" },
  { currentMode: "standard", expectedMode: "standard" },
  { currentMode: "deep", expectedMode: "deep" },
];

function resolvedRegion(code: RegionCode) {
  return { code, source: "explicit" as const };
}

describe("resolveProtectionRequest", () => {
  it.each(
    CURRENT_MODE_CASES.flatMap(({ currentMode, expectedMode }) =>
      REGION_CODES.map((region) => ({ currentMode, expectedMode, region })),
    ),
  )(
    "$currentMode + omitted level + $region resolves to $expectedMode/$region",
    ({ currentMode, expectedMode, region }) => {
      expect(resolveProtectionRequest({ currentMode, resolvedRegion: resolvedRegion(region) })).toEqual({
        mode: expectedMode,
        region,
      });
    },
  );

  it.each(
    (["standard", "deep"] as const).flatMap((level) =>
      CURRENT_MODE_CASES.flatMap(({ currentMode }) =>
        REGION_CODES.map((region) => ({ currentMode, level, region })),
      ),
    ),
  )(
    "$currentMode + explicit $level + $region resolves to one target",
    ({ currentMode, level, region }) => {
      expect(
        resolveProtectionRequest({
          currentMode,
          resolvedRegion: resolvedRegion(region),
          level,
        }),
      ).toEqual({ mode: level, region });
    },
  );

  it.each(REGION_CODES)("--deep aliases an explicit deep level for %s", (region) => {
    expect(
      resolveProtectionRequest({
        currentMode: "daily",
        resolvedRegion: resolvedRegion(region),
        deep: true,
      }),
    ).toEqual({ mode: "deep", region });
  });

  it("rejects conflicting --deep and --level standard", () => {
    expect(() =>
      resolveProtectionRequest({
        currentMode: "standard",
        resolvedRegion: resolvedRegion("us"),
        level: "standard",
        deep: true,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFLICTING_PROTECTION_LEVEL",
        level: "standard",
        deep: true,
      }),
    );
  });

  it("allows matching --deep and --level deep", () => {
    expect(
      resolveProtectionRequest({
        currentMode: "standard",
        resolvedRegion: resolvedRegion("eu"),
        level: "deep",
        deep: true,
      }),
    ).toEqual({ mode: "deep", region: "eu" });
  });

  it.each(["", " ", "daily", "STANDARD", "unknown", null])(
    "rejects invalid explicit level %j",
    (level) => {
      let error: unknown;
      try {
        resolveProtectionRequest({
          currentMode: "daily",
          resolvedRegion: resolvedRegion("jp"),
          level,
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(ProtectionRequestError);
      expect(error).toMatchObject({
        code: "INVALID_PROTECTION_LEVEL",
        level,
        validLevels: ["standard", "deep"],
      });
    },
  );
});
