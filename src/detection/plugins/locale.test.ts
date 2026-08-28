// Intl Locale 检测插件测试

import { describe, it, expect, vi } from "vitest";

const { state } = vi.hoisted(() => ({ state: { locale: "en-US" } }));

vi.mock("../../platform/system-state.js", () => ({
  readUserLocale: async () => state.locale,
}));

import { localePlugin } from "./locale.js";

describe("localePlugin", () => {
  it("高危 locale（zh-CN）判定为高风险", async () => {
    state.locale = "zh-CN";
    const result = await localePlugin.run({ targetTimezone: "America/New_York", targetLang: "en_US" });
    expect(result.value).toBe("zh-CN");
    expect(result.risk).toBe("high");
    expect(result.score).toBe(1);
    expect(result.contribution).toBe(6);
  });

  it("目标语言一致的 locale 判定为低风险", async () => {
    state.locale = "en-US";
    const result = await localePlugin.run({ targetTimezone: "America/New_York", targetLang: "en_US" });
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
  });

  it("未知 locale 判定为中风险", async () => {
    state.locale = "fr-CA";
    const result = await localePlugin.run({ targetTimezone: "America/New_York", targetLang: "en_US" });
    expect(result.risk).toBe("medium");
    expect(result.score).toBe(0.5);
    expect(result.contribution).toBe(3); // Math.round(0.5 * 6)
  });

  it("读取失败时回退 Intl 解析结果", async () => {
    state.locale = null;
    const result = await localePlugin.run({ targetTimezone: "America/New_York", targetLang: "en_US" });
    expect(result.value).toBe(Intl.DateTimeFormat().resolvedOptions().locale);
  });
});
