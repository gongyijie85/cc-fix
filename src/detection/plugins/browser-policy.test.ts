// 浏览器策略检测插件测试 — 缺失 / 非法 / 规范三种槽位状态（槽 id 词汇）

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockedReadPolicyValues } = vi.hoisted(() => ({
  mockedReadPolicyValues: vi.fn<(browser: string) => Record<string, string | null>>(),
}));

vi.mock("../../platform/browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../platform/browser.js")>();
  return { ...actual, readPolicyValues: mockedReadPolicyValues };
});

import { browserPolicyPlugin } from "./browser-policy.js";
import { desiredBrowserPolicies, BROWSER_POLICY_SLOTS } from "../../state/schema.js";

const CONTEXT = { targetTimezone: "Asia/Singapore", targetLang: "en_SG.UTF-8" };
const TARGETS = desiredBrowserPolicies(CONTEXT.targetLang);

/** 生成满足全部槽位的 valueName→值 记录（按浏览器分组）。 */
function valuesFor(browser: string, override: (slotId: string, target: string | null) => string | null = (_, target) => target): Record<string, string | null> {
  const record: Record<string, string | null> = {};
  for (const slot of BROWSER_POLICY_SLOTS.filter((s) => s.browser === browser)) {
    record[slot.valueName] = override(slot.id, TARGETS[slot.id]);
  }
  return record;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("browserPolicyPlugin", () => {
  it("六槽位均为规范值：通过，risk low", async () => {
    mockedReadPolicyValues.mockImplementation((browser) => valuesFor(browser));

    const result = await browserPolicyPlugin.run(CONTEXT);
    expect(result.risk).toBe("low");
    expect(result.score).toBe(0);
    expect(result.contribution).toBe(0);
    expect(result.value).toContain("已就位");
  });

  it("六槽位全部缺失：6/6 异常，risk high，附未设置提示", async () => {
    mockedReadPolicyValues.mockReturnValue({});

    const result = await browserPolicyPlugin.run(CONTEXT);
    expect(result.risk).toBe("high");
    expect(result.score).toBe(1);
    expect(result.contribution).toBe(5);
    expect(result.value).toContain("6/6 槽位异常");
    expect(result.value).toContain("(未设置)");
  });

  it("取值非法（非缺失）：报异常并附当前值", async () => {
    mockedReadPolicyValues.mockImplementation((browser) =>
      valuesFor(browser, (slotId) => {
        if (slotId === "chrome.accept_language") return "zh-CN";
        if (slotId === "edge.webrtc") return "disable_non_proxied";
        return TARGETS[slotId as keyof typeof TARGETS];
      }),
    );

    const result = await browserPolicyPlugin.run(CONTEXT);
    // 2/6 异常
    expect(result.risk).toBe("medium");
    expect(result.score).toBeCloseTo(2 / 6);
    expect(result.contribution).toBe(Math.round((2 / 6) * 5));
    expect(result.value).toContain("2/6 槽位异常");
    expect(result.value).toContain("Chrome/AcceptLanguage=zh-CN");
    expect(result.value).toContain("Edge/WebRTC 防泄漏=disable_non_proxied");
  });

  it("AcceptLanguage 跟随目标地区推导（ja_JP.UTF-8 → ja-JP）", async () => {
    const jaTargets = desiredBrowserPolicies("ja_JP.UTF-8");
    mockedReadPolicyValues.mockImplementation((browser) => {
      const record: Record<string, string | null> = {};
      for (const slot of BROWSER_POLICY_SLOTS.filter((s) => s.browser === browser)) {
        record[slot.valueName] = jaTargets[slot.id];
      }
      return record;
    });

    const result = await browserPolicyPlugin.run({
      targetTimezone: "Asia/Tokyo",
      targetLang: "ja_JP.UTF-8",
    });
    expect(result.risk).toBe("low");
    expect(result.score).toBe(0);
  });

  it("信号元数据符合标准形状", async () => {
    mockedReadPolicyValues.mockReturnValue({});

    const result = await browserPolicyPlugin.run(CONTEXT);
    expect(result).toMatchObject({
      id: "browser-policy",
      label: "浏览器策略",
      weight: 5,
      source: "system",
    });
  });
});
