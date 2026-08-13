import { describe, expect, it } from "vitest";
import {
  REGION_CODES,
  RegionResolutionError,
  isRegionCode,
  resolveRegion,
} from "./region.js";

describe("resolveRegion", () => {
  it.each([
    {
      name: "explicit wins over active and preferred",
      input: { explicit: "jp", active: "eu", preferred: "sg" },
      expected: { code: "jp", source: "explicit" },
    },
    {
      name: "active wins over preferred when explicit is absent",
      input: { active: "eu", preferred: "sg" },
      expected: { code: "eu", source: "active" },
    },
    {
      name: "preferred is used when explicit and active are absent",
      input: { preferred: "sg" },
      expected: { code: "sg", source: "preferred" },
    },
    {
      name: "US is the initial default only when every input is absent",
      input: {},
      expected: { code: "us", source: "initial_default" },
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveRegion(input)).toEqual(expected);
  });

  it.each(REGION_CODES)("resolves explicit region %s", (code) => {
    expect(resolveRegion({ explicit: code })).toEqual({ code, source: "explicit" });
  });

  it.each([
    ["explicit", ""],
    ["explicit", "   "],
    ["explicit", "US"],
    ["explicit", "Us"],
    ["explicit", "unknown"],
    ["explicit", null],
    ["active", ""],
    ["active", "EU"],
    ["active", "unknown"],
    ["active", null],
    ["preferred", ""],
    ["preferred", "JP"],
    ["preferred", "unknown"],
    ["preferred", null],
  ] as const)("rejects invalid %s value %j without fallback", (source, value) => {
    let error: unknown;
    try {
      resolveRegion({ [source]: value });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RegionResolutionError);
    expect(error).toMatchObject({
      code: "INVALID_REGION",
      source,
      value,
      validRegions: REGION_CODES,
    });
  });
});

describe("isRegionCode", () => {
  it.each(REGION_CODES)("accepts %s", (code) => {
    expect(isRegionCode(code)).toBe(true);
  });

  it.each(["", "us ", "US", "cn", null, undefined, 1])("rejects %j", (value) => {
    expect(isRegionCode(value)).toBe(false);
  });
});
