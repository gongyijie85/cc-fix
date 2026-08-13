import { describe, it, expect } from "vitest";
import { getTargetRegion, DEFAULT_REGION, TARGET_REGIONS } from "./regions.js";

describe("getTargetRegion", () => {
  it("returns US by default", () => {
    const region = getTargetRegion(DEFAULT_REGION);
    expect(region.code).toBe("us");
    expect(region.timezone).toBe("America/New_York");
    expect(region.winTimezone).toBe("Eastern Standard Time");
    expect(region.lang).toBe("en_US.UTF-8");
  });

  it("returns correct region for known codes", () => {
    const jp = getTargetRegion("jp");
    expect(jp.timezone).toBe("Asia/Tokyo");

    const eu = getTargetRegion("eu");
    expect(eu.timezone).toBe("Europe/London");
  });

  it("rejects unknown codes instead of silently falling back to US", () => {
    expect(() => getTargetRegion("unknown")).toThrow();
  });
});

describe("TARGET_REGIONS", () => {
  it("has exactly the four domain regions", () => {
    expect(Object.keys(TARGET_REGIONS)).toEqual(["us", "eu", "jp", "sg"]);
  });

  it("each region has required fields", () => {
    for (const region of Object.values(TARGET_REGIONS)) {
      expect(region.code).toBeTruthy();
      expect(region.name).toBeTruthy();
      expect(region.timezone).toBeTruthy();
      expect(region.lang).toBeTruthy();
      expect(region.lcAll).toBeTruthy();
    }
  });
});
