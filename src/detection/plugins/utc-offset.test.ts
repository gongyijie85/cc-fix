// UTC 偏移检测插件测试

import { describe, it, expect, vi, afterEach } from "vitest";

const { state } = vi.hoisted(() => ({ state: { offsetMinutes: -240 } }));

vi.mock("../../platform/system-state.js", () => ({
  systemState: async () => ({ timezone: "America/New_York", offsetMinutes: state.offsetMinutes }),
}));

import { utcOffsetPlugin } from "./utc-offset.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("utcOffsetPlugin", () => {
  it("纽约夏令时（UTC-4）判定为低风险", async () => {
    state.offsetMinutes = -240;
    const result = await utcOffsetPlugin.run({ targetTimezone: "America/New_York", targetLang: "en" });
    expect(result.value).toBe("UTC-04:00");
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
  });

  it("纽约冬令时（UTC-5，精确匹配）判定为低风险", async () => {
    state.offsetMinutes = -300;
    const result = await utcOffsetPlugin.run({ targetTimezone: "America/New_York", targetLang: "en" });
    expect(result.value).toBe("UTC-05:00");
    expect(result.risk).toBe("low");
  });

  it("北京时区（UTC+8）对纽约目标判定为中风险", async () => {
    state.offsetMinutes = 480;
    const result = await utcOffsetPlugin.run({ targetTimezone: "America/New_York", targetLang: "en" });
    expect(result.value).toBe("UTC+08:00");
    expect(result.risk).toBe("medium");
    expect(result.contribution).toBe(4);
  });

  it("returns low risk for unknown timezone", async () => {
    const result = await utcOffsetPlugin.run({ targetTimezone: "Unknown/Timezone", targetLang: "en" });
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
  });

  it("formats offset correctly", async () => {
    const result = await utcOffsetPlugin.run({ targetTimezone: "Asia/Tokyo", targetLang: "en" });
    expect(result.value).toMatch(/^UTC[+-]\d{2}:\d{2}$/);
  });
});
