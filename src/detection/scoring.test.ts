import { describe, it, expect } from "vitest";
import { calculateScore, getRiskLevel, getAccessStatus, generateRecommendations } from "./scoring.js";
import type { SignalResult } from "./types.js";

function makeSignal(overrides: Partial<SignalResult> = {}): SignalResult {
  return {
    id: "test",
    label: "Test",
    value: "test",
    score: 0,
    weight: 10,
    contribution: 0,
    source: "system",
    risk: "low",
    ...overrides,
  };
}

describe("calculateScore", () => {
  it("returns 0 for no signals", () => {
    expect(calculateScore([])).toBe(0);
  });

  it("sums contributions", () => {
    const signals = [
      makeSignal({ contribution: 10 }),
      makeSignal({ contribution: 20 }),
    ];
    expect(calculateScore(signals)).toBe(30);
  });

  it("caps at 100", () => {
    const signals = [
      makeSignal({ contribution: 60 }),
      makeSignal({ contribution: 60 }),
    ];
    expect(calculateScore(signals)).toBe(100);
  });

  it("floors at 0", () => {
    const signals = [makeSignal({ contribution: -5 })];
    expect(calculateScore(signals)).toBe(0);
  });
});

describe("getRiskLevel", () => {
  it("returns low for 0-20", () => {
    expect(getRiskLevel(0)).toBe("low");
    expect(getRiskLevel(20)).toBe("low");
  });

  it("returns medium for 21-50", () => {
    expect(getRiskLevel(21)).toBe("medium");
    expect(getRiskLevel(50)).toBe("medium");
  });

  it("returns high for 51-70", () => {
    expect(getRiskLevel(51)).toBe("high");
    expect(getRiskLevel(70)).toBe("high");
  });

  it("returns critical for 71+", () => {
    expect(getRiskLevel(71)).toBe("critical");
    expect(getRiskLevel(100)).toBe("critical");
  });
});

describe("getAccessStatus", () => {
  it("returns supported for 0", () => {
    expect(getAccessStatus(0)).toBe("supported");
  });

  it("returns restricted for 70+", () => {
    expect(getAccessStatus(70)).toBe("restricted");
  });
});

describe("generateRecommendations", () => {
  it("returns positive message for score 0", () => {
    const recs = generateRecommendations([], 0);
    expect(recs).toContain("环境信号正常，继续保持");
  });

  it("recommends persist for high risk timezone", () => {
    const signals = [makeSignal({ id: "timezone", risk: "high" })];
    const recs = generateRecommendations(signals, 50);
    expect(recs.some((r) => r.includes("persist on"))).toBe(true);
  });

  it("recommends persist for high risk language", () => {
    const signals = [makeSignal({ id: "language", risk: "high" })];
    const recs = generateRecommendations(signals, 50);
    expect(recs.some((r) => r.includes("persist on"))).toBe(true);
  });
});
