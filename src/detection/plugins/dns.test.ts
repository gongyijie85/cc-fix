// DNS 检测插件测试

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 模拟 node:dns.lookup 的回调签名 (host, options, callback)
const { mockLookup } = vi.hoisted(() => {
  type Resolver = (host: string, options: { signal?: AbortSignal }) => Promise<{ address: string; family: number }>;
  const state: { resolve: Resolver } = {
    resolve: async () => ({ address: "104.18.1.1", family: 4 }),
  };
  const mockLookup = vi.fn(
    (host: string, options: { signal?: AbortSignal } | number | undefined, cb?: (error: Error | null, address?: string, family?: number) => void) => {
      const opts = typeof options === "object" && options !== null ? options : {};
      state.resolve(host, opts).then(
        (r) => cb?.(null, r.address, r.family),
        (e) => cb?.(e instanceof Error ? e : new Error(String(e))),
      );
    },
  );
  mockLookup.__setState = (resolve: Resolver) => {
    state.resolve = resolve;
  };
  return { mockLookup };
});

vi.mock("node:dns", () => ({
  default: { lookup: mockLookup },
}));

import { createDnsPlugin, dnsPlugin } from "./dns.js";

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
      json: async () => ({ success: true, country: "China", country_code: "CN", connection: { asn: 4134, org: "CHINANET" } }),
    }) as unknown as typeof fetch;

    const result = await dnsPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    // 不再因「非目标国家」加分（CDN/边缘常态）
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
  });

  it("treats geo 200-with-success=false as lookup failure", async () => {
    mockLookup.__setState(async () => ({ address: "8.8.8.8", family: 4 }));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, message: "Reserved range" }),
    }) as unknown as typeof fetch;

    const result = await dnsPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.risk).toBe("low");
    expect(result.value).toContain("无法查询地理位置");
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

  it("geo ASN=Cloudflare(13335) 对非前缀 IP 判定 CDN 而不误报", async () => {
    mockLookup.__setState(async () => ({ address: "1.2.3.4", family: 4 }));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, country: "United States", country_code: "US", connection: { asn: 13335, org: "Cloudflare, Inc." } }),
    }) as unknown as typeof fetch;

    const result = await dnsPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.risk).toBe("low");
    expect(result.value).toContain("Cloudflare");
  });

  it("reports medium risk when DNS resolution fails (network unreachable is not 'safe') (#117)", async () => {
    mockLookup.__setState(async () => {
      throw new Error("ENOTFOUND");
    });

    const result = await dnsPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.risk).toBe("medium");
    expect(result.contribution).toBe(0);
    expect(result.value).toContain("DNS 解析失败");
  });

  it("abandons a stalled lookup within the timeout instead of blocking the detection flow", async () => {
    // 模拟真实 dns.lookup 的 signal 行为：挂起直到 abort，abort 后拒绝
    mockLookup.__setState(async (_host, options) => {
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal!.reason));
      });
      return { address: "1.2.3.4", family: 4 };
    });

    const plugin = createDnsPlugin(undefined, 50); // 50ms 硬超时
    const started = Date.now();
    const result = await plugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.risk).toBe("medium");
    expect(result.contribution).toBe(0);
    expect(result.value).toContain("解析失败");
  });

  it("abandons a lookup that ignores the abort signal via race fallback", async () => {
    // 恶意/异常实现：完全不理会 signal，永远不返回
    mockLookup.__setState(() => new Promise(() => {}));

    const plugin = createDnsPlugin(undefined, 50);
    const started = Date.now();
    const result = await plugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.risk).toBe("medium");
    expect(result.value).toContain("解析失败");
  });
});
