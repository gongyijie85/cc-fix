// 时区检测插件测试

import { describe, it, expect, vi } from "vitest";

const { state } = vi.hoisted(() => ({ state: { timezone: "America/New_York" } }));

vi.mock("../../platform/system-state.js", () => ({
  systemState: async () => ({ timezone: state.timezone, offsetMinutes: -240 }),
}));

import { timezonePlugin } from "./timezone.js";

describe("timezonePlugin", () => {
  it("目标时区一致判定为低风险", async () => {
    state.timezone = "America/New_York";
    const result = await timezonePlugin.run({ targetTimezone: "America/New_York", targetLang: "en" });
    expect(result.value).toBe("America/New_York");
    expect(result.risk).toBe("low");
    expect(result.score).toBe(0);
    expect(result.contribution).toBe(0);
  });

  it("高危时区（Asia/Shanghai）判定为高风险", async () => {
    state.timezone = "Asia/Shanghai";
    const result = await timezonePlugin.run({ targetTimezone: "America/New_York", targetLang: "en" });
    expect(result.risk).toBe("high");
    expect(result.score).toBe(1);
    expect(result.contribution).toBe(25);
  });

  it("非目标且非高危时区判定为中风险", async () => {
    state.timezone = "Europe/Paris";
    const result = await timezonePlugin.run({ targetTimezone: "America/New_York", targetLang: "en" });
    expect(result.risk).toBe("medium");
    expect(result.score).toBe(0.5);
    expect(result.contribution).toBe(13); // Math.round(0.5 * 25)
  });

  it("高危判定优先于目标一致（即使目标匹配也保持 high）", async () => {
    state.timezone = "Asia/Shanghai";
    const result = await timezonePlugin.run({ targetTimezone: "Asia/Shanghai", targetLang: "en" });
    expect(result.risk).toBe("high");
    expect(result.score).toBe(1);
  });
});
