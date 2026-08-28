// 信号一致性检测插件测试

import { describe, it, expect, vi } from "vitest";
import type { IpIntelligence } from "../types.js";

const { state } = vi.hoisted(() => ({ state: { timezone: "America/New_York", locale: "en-US" } }));

vi.mock("../../platform/system-state.js", () => ({
  systemState: async () => ({ timezone: state.timezone, offsetMinutes: -240 }),
  readUserLocale: async () => state.locale,
}));

import { createConsistencyPlugin } from "./consistency.js";

function nullIp(): IpIntelligence {
  return {
    ip: null, country: null, region: null, city: null,
    asn: null, org: null, timezone: null,
    ipType: "unknown", multiSourceConsistent: true, sourceCount: 0,
  };
}

function usIp(): IpIntelligence {
  return { ...nullIp(), country: "US" };
}

describe("createConsistencyPlugin", () => {
  it("时区、locale 与 IP 全部一致判定为一致", async () => {
    state.timezone = "America/New_York";
    state.locale = "en-US";
    const result = await createConsistencyPlugin(usIp()).run({
      targetTimezone: "America/New_York",
      targetLang: "en_US",
    });
    expect(result.value).toBe("一致");
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
  });

  it("单个不一致（时区）判定为中风险", async () => {
    state.timezone = "Europe/Paris";
    state.locale = "en-US";
    const result = await createConsistencyPlugin(usIp()).run({
      targetTimezone: "America/New_York",
      targetLang: "en_US",
    });
    expect(result.risk).toBe("medium");
    expect(result.score).toBe(0.5);
    expect(result.contribution).toBe(8); // Math.round(0.5 * 15)
    expect(result.value).toContain("时区(Europe/Paris)≠目标(America/New_York)");
  });

  it("多个不一致（时区 + locale）判定为高风险", async () => {
    state.timezone = "Asia/Shanghai";
    state.locale = "zh-CN";
    const result = await createConsistencyPlugin(usIp()).run({
      targetTimezone: "America/New_York",
      targetLang: "en_US",
    });
    expect(result.risk).toBe("high");
    expect(result.score).toBe(1);
    expect(result.contribution).toBe(15);
  });

  it("目标为纽约且 IP 国家非 US 时计入不一致", async () => {
    state.timezone = "America/New_York";
    state.locale = "en-US";
    const result = await createConsistencyPlugin({ ...nullIp(), country: "SG" }).run({
      targetTimezone: "America/New_York",
      targetLang: "en_US",
    });
    expect(result.risk).toBe("medium");
    expect(result.value).toBe("IP(SG)≠目标(US)");
  });

  it("非纽约目标不触发 IP 国家检查", async () => {
    state.timezone = "Asia/Tokyo";
    state.locale = "ja-JP";
    const result = await createConsistencyPlugin({ ...nullIp(), country: "SG" }).run({
      targetTimezone: "Asia/Tokyo",
      targetLang: "ja_JP",
    });
    expect(result.value).toBe("一致");
    expect(result.risk).toBe("low");
  });

  it("无 IP 情报时不检查 IP 一致性", async () => {
    state.timezone = "America/New_York";
    state.locale = "en-US";
    const result = await createConsistencyPlugin(null).run({
      targetTimezone: "America/New_York",
      targetLang: "en_US",
    });
    expect(result.value).toBe("一致");
    expect(result.risk).toBe("low");
  });
});
