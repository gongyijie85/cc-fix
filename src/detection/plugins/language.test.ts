// 语言检测插件测试

import { describe, it, expect, vi, afterEach } from "vitest";

const { state } = vi.hoisted(() => ({ state: { lang: "en_US.UTF-8", lcAll: null } }));

vi.mock("../../platform/system-state.js", () => ({
  readUserEnvVar: async (name: string) => (name === "LANG" ? state.lang : state.lcAll),
}));

import { languagePlugin } from "./language.js";

describe("languagePlugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("目标语言一致判定为低风险", async () => {
    state.lang = "en_US.UTF-8";
    state.lcAll = null;
    const result = await languagePlugin.run({ targetTimezone: "America/New_York", targetLang: "en_US.UTF-8" });
    expect(result.value).toBe("en_US.UTF-8");
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
  });

  it("高危语言（zh_CN）判定为高风险", async () => {
    state.lang = "zh_CN.UTF-8";
    state.lcAll = null;
    const result = await languagePlugin.run({ targetTimezone: "America/New_York", targetLang: "en_US.UTF-8" });
    expect(result.risk).toBe("high");
    expect(result.score).toBe(1);
    expect(result.contribution).toBe(20);
  });

  it("LC_ALL 回退：LANG 为空时读取 LC_ALL", async () => {
    state.lang = null;
    state.lcAll = "de_DE.UTF-8";
    const result = await languagePlugin.run({ targetTimezone: "America/New_York", targetLang: "en_US.UTF-8" });
    expect(result.value).toBe("de_DE.UTF-8");
    expect(result.risk).toBe("medium");
    expect(result.contribution).toBe(10);
  });

  it("全部来源缺失时回退到 unknown（当前行为：按非目标计中风险）", async () => {
    state.lang = null;
    state.lcAll = null;
    const saved = {
      LANG: process.env.LANG,
      LANGUAGE: process.env.LANGUAGE,
      LC_ALL: process.env.LC_ALL,
    };
    delete process.env.LANG;
    delete process.env.LANGUAGE;
    delete process.env.LC_ALL;
    try {
      const result = await languagePlugin.run({ targetTimezone: "America/New_York", targetLang: "en_US.UTF-8" });
      expect(result.value).toBe("unknown");
      // 锁定当前实现：unknown 走「非目标」分支（中风险）；若未来改为「未知=低风险」需更新此处。
      expect(result.risk).toBe("medium");
      expect(result.contribution).toBe(10);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("非目标语言判定为中风险", async () => {
    state.lang = "ja_JP.UTF-8";
    state.lcAll = null;
    const result = await languagePlugin.run({ targetTimezone: "America/New_York", targetLang: "en_US.UTF-8" });
    expect(result.risk).toBe("medium");
    expect(result.score).toBe(0.5);
  });
});
