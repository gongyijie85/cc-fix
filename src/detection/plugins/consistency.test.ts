// 信号一致性检测插件测试

import { describe, it, expect, vi } from "vitest";
import type { IpIntelligence } from "../types.js";

const { state } = vi.hoisted(() => ({ state: { timezone: "America/New_York", locale: "en-US" } }));

vi.mock("../../platform/system-state.js", () => ({
  systemState: async () => ({ timezone: state.timezone, offsetMinutes: -240 }),
  readUserLocale: async () => state.locale,
}));

vi.mock("../corporate-allowlist.js", () => ({
  isCorporateIp: async (ip: string | null) => ip === "10.0.0.1",
  isCorporateAsn: async () => false,
}));

import { createConsistencyPlugin } from "./consistency.js";

function nullIp(): IpIntelligence {
  return {
    ip: null, country: null, region: null, city: null,
    asn: null, org: null, timezone: null,
    ipType: "unknown", multiSourceConsistent: true, sourceCount: 0,
  };
}

function ipOf(country: string | null, ip: string | null = null): IpIntelligence {
  return { ...nullIp(), country: country ? country.toUpperCase() : null, ip };
}

describe("createConsistencyPlugin", () => {
  it("时区、locale 与 IP 全部一致判定为一致", async () => {
    state.timezone = "America/New_York";
    state.locale = "en-US";
    const result = await createConsistencyPlugin(ipOf("US")).run({
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
    const result = await createConsistencyPlugin(ipOf("US")).run({
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
    const result = await createConsistencyPlugin(ipOf("US")).run({
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
    const result = await createConsistencyPlugin(ipOf("SG")).run({
      targetTimezone: "America/New_York",
      targetLang: "en_US",
    });
    expect(result.risk).toBe("medium");
    expect(result.value).toBe("IP(SG)≠目标(US)");
  });

  // #106：非 US 目标也执行 IP 国家一致性（此前只有 New_York 目标触发）
  it("目标东京且 IP 国家为 JP 时一致", async () => {
    state.timezone = "Asia/Tokyo";
    state.locale = "ja-JP";
    const result = await createConsistencyPlugin(ipOf("JP")).run({
      targetTimezone: "Asia/Tokyo",
      targetLang: "ja_JP",
    });
    expect(result.value).toBe("一致");
    expect(result.risk).toBe("low");
  });

  it("目标东京且 IP 国家非 JP（如 SG）时计入不一致", async () => {
    state.timezone = "Asia/Tokyo";
    state.locale = "ja-JP";
    const result = await createConsistencyPlugin(ipOf("SG")).run({
      targetTimezone: "Asia/Tokyo",
      targetLang: "ja_JP",
    });
    expect(result.risk).toBe("medium");
    expect(result.value).toBe("IP(SG)≠目标(JP)");
  });

  it("目标新加坡且 IP 国家非 SG 时计入不一致", async () => {
    state.timezone = "Asia/Singapore";
    state.locale = "en-SG";
    const result = await createConsistencyPlugin(ipOf("US")).run({
      targetTimezone: "Asia/Singapore",
      targetLang: "en_SG",
    });
    expect(result.risk).toBe("medium");
    expect(result.value).toBe("IP(US)≠目标(SG)");
  });

  it("目标伦敦且 IP 为欧洲国家时一致", async () => {
    state.timezone = "Europe/London";
    state.locale = "en-GB";
    const result = await createConsistencyPlugin(ipOf("FR")).run({
      targetTimezone: "Europe/London",
      targetLang: "en_GB",
    });
    expect(result.value).toBe("一致");
    expect(result.risk).toBe("low");
  });

  it("目标伦敦且 IP 为欧洲外国家时计入不一致", async () => {
    state.timezone = "Europe/London";
    state.locale = "en-GB";
    const result = await createConsistencyPlugin(ipOf("US")).run({
      targetTimezone: "Europe/London",
      targetLang: "en_GB",
    });
    expect(result.risk).toBe("medium");
    expect(result.value).toBe("IP(US)≠目标(EU)");
  });

  it("企业白名单 IP 在目标 EU 下豁免", async () => {
    state.timezone = "Europe/London";
    state.locale = "en-GB";
    const result = await createConsistencyPlugin(ipOf("US", "10.0.0.1")).run({
      targetTimezone: "Europe/London",
      targetLang: "en_GB",
    });
    expect(result.value).toBe("IP(US) 为企业白名单，已豁免");
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

  it("未知目标时区不触发 IP 检查（防御未知画像误报）", async () => {
    state.timezone = "Pacific/Auckland";
    state.locale = "en-NZ";
    const result = await createConsistencyPlugin(ipOf("US")).run({
      targetTimezone: "Pacific/Auckland",
      targetLang: "en_NZ",
    });
    expect(result.value).toBe("一致");
    expect(result.risk).toBe("low");
  });
});
