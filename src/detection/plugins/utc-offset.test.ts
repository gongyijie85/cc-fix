// UTC 偏移检测插件测试

import { describe, it, expect, vi, afterEach } from "vitest";
import { utcOffsetPlugin } from "./utc-offset.js";

function mockOffset(tzOffsetMinutes: number) {
  vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(tzOffsetMinutes);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("utcOffsetPlugin", () => {
  it("纽约夏令时（UTC-4）判定为低风险", async () => {
    // getTimezoneOffset 西为正：UTC-4 => 240
    mockOffset(240);
    const result = await utcOffsetPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.value).toBe("UTC-04:00");
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
  });

  it("纽约冬令时（UTC-5，精确匹配）判定为低风险", async () => {
    mockOffset(300);
    const result = await utcOffsetPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.value).toBe("UTC-05:00");
    expect(result.risk).toBe("low");
  });

  it("北京时区（UTC+8）对纽约目标判定为中风险", async () => {
    // UTC+8 => getTimezoneOffset 返回 -480
    mockOffset(-480);
    const result = await utcOffsetPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.value).toBe("UTC+08:00");
    expect(result.risk).toBe("medium");
    expect(result.contribution).toBe(4);
  });

  it("returns low risk for unknown timezone", async () => {
    const result = await utcOffsetPlugin.run({
      targetTimezone: "Unknown/Timezone",
      targetLang: "en",
    });
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
  });

  it("formats offset correctly", async () => {
    const result = await utcOffsetPlugin.run({
      targetTimezone: "Asia/Tokyo",
      targetLang: "en",
    });
    // Value should be in UTC±HH:MM format
    expect(result.value).toMatch(/^UTC[+-]\d{2}:\d{2}$/);
  });
});
