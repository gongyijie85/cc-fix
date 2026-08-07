// DNS 检测插件测试

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 模拟真实 dns.lookup 的 promisify.custom 行为（返回 { address, family }）
const { mockLookup } = vi.hoisted(() => {
  type Resolver = (host: string) => Promise<{ address: string; family: number }>;
  const state: { resolve: Resolver } = {
    resolve: async () => ({ address: "104.18.1.1", family: 4 }),
  };
  const mockLookup = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: (host: string) => state.resolve(host),
    __setState: (resolve: Resolver) => {
      state.resolve = resolve;
    },
  });
  return { mockLookup };
});

vi.mock("node:dns", () => ({
  default: { lookup: mockLookup },
}));

import { dnsPlugin } from "./dns.js";

describe("dnsPlugin", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockLookup.__setState(async () => ({ address: "104.18.1.1", family: 4 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns low risk for Cloudflare CDN IPs without geo penalty", async () => {
    const result = await dnsPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.id).toBe("dns");
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
    expect(result.value).toContain("Cloudflare");
  });

  it("returns low risk for Clash fake-ip 198.18.x (proxy takeover)", async () => {
    mockLookup.__setState(async () => ({ address: "198.18.0.16", family: 4 }));

    const result = await dnsPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
    expect(result.value).toContain("fake-ip");
  });

  it("returns medium risk for other private ranges", async () => {
    mockLookup.__setState(async () => ({ address: "10.0.0.1", family: 4 }));

    const result = await dnsPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.risk).toBe("medium");
    expect(result.contribution).toBe(6);
    expect(result.value).toContain("污染");
  });

  it("returns low risk for other public IPs even if geo country differs", async () => {
    mockLookup.__setState(async () => ({ address: "1.2.3.4", family: 4 }));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ country: "China", countryCode: "CN", as: "AS4134" }),
    }) as unknown as typeof fetch;

    const result = await dnsPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    // 不再因「非目标国家」加分（CDN/边缘常态）
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
  });

  it("returns low risk when geo lookup fails for non-CDN IP", async () => {
    mockLookup.__setState(async () => ({ address: "8.8.8.8", family: 4 }));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

    const result = await dnsPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
  });

  it("returns low risk when DNS resolution fails (network unreachable)", async () => {
    mockLookup.__setState(async () => {
      throw new Error("ENOTFOUND");
    });

    const result = await dnsPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
    expect(result.value).toContain("DNS 解析失败");
  });
});
