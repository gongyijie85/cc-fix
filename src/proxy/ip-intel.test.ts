// IP 情报增强测试 — 多源一致性 + 数据中心 ASN 判断（#70：ipwho.is 主源全 HTTPS）

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { fetchIpIntelligence, resetIpIntelCache } from "./ip-intel.js";

function ipWhoIsResponse(asn: number, countryCode = "US", ip = "203.0.113.1") {
  return {
    ip,
    success: true,
    country: "United States",
    country_code: countryCode,
    region: "California",
    city: "Los Angeles",
    connection: { asn, org: "Some Network" },
    timezone: { id: "America/Los_Angeles" },
  };
}

function ipinfoResponse(org: string, country = "US") {
  return {
    ip: "203.0.113.1",
    country,
    region: "California",
    city: "Los Angeles",
    org,
    timezone: "America/Los_Angeles",
  };
}

function mockFetchBySources(sources: Record<string, unknown>) {
  return vi.fn((url: string | URL | Request) => {
    const href = String(url);
    for (const [key, data] of Object.entries(sources)) {
      if (href.includes(key)) {
        return Promise.resolve({ ok: true, json: async () => data });
      }
    }
    return Promise.resolve({ ok: false });
  }) as unknown as typeof fetch;
}

describe("fetchIpIntelligence", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetIpIntelCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("detects datacenter IP by cloud ASN prefix", async () => {
    globalThis.fetch = mockFetchBySources({
      "ipwho.is": ipWhoIsResponse(16509),
      "ipinfo.io": ipinfoResponse("AS16509 Amazon.com, Inc."),
    });

    const intel = await fetchIpIntelligence();
    expect(intel).not.toBeNull();
    expect(intel!.ipType).toBe("datacenter");
    expect(intel!.asn).toBe("AS16509");
    expect(intel!.multiSourceConsistent).toBe(true);
    expect(intel!.sourceCount).toBe(2);
  });

  it("classifies residential IP when ASN not in datacenter list", async () => {
    globalThis.fetch = mockFetchBySources({
      "ipwho.is": ipWhoIsResponse(7922),
      "ipinfo.io": ipinfoResponse("AS7922 Comcast Cable Communications"),
    });

    const intel = await fetchIpIntelligence();
    expect(intel!.ipType).toBe("residential");
    expect(intel!.multiSourceConsistent).toBe(true);
  });

  it("flags multi-source inconsistency on country mismatch", async () => {
    globalThis.fetch = mockFetchBySources({
      "ipwho.is": ipWhoIsResponse(7922, "US"),
      "ipinfo.io": ipinfoResponse("AS7922 Comcast Cable", "JP"),
    });

    const intel = await fetchIpIntelligence();
    expect(intel!.multiSourceConsistent).toBe(false);
    expect(intel!.sourceCount).toBe(2);
  });

  it("flags multi-source inconsistency on ASN mismatch", async () => {
    globalThis.fetch = mockFetchBySources({
      "ipwho.is": ipWhoIsResponse(7922),
      "ipinfo.io": ipinfoResponse("AS16509 Amazon"),
    });

    const intel = await fetchIpIntelligence();
    expect(intel!.multiSourceConsistent).toBe(false);
  });

  it("falls back to single source when secondary fails", async () => {
    globalThis.fetch = mockFetchBySources({
      "ipwho.is": ipWhoIsResponse(7922),
    });

    const intel = await fetchIpIntelligence();
    expect(intel).not.toBeNull();
    expect(intel!.sourceCount).toBe(1);
    expect(intel!.multiSourceConsistent).toBe(true);
  });

  it("returns null when all sources fail", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;

    const intel = await fetchIpIntelligence();
    expect(intel).toBeNull();
  });

  it("reads ipwho.is ip field as exit IP", async () => {
    globalThis.fetch = mockFetchBySources({
      "ipwho.is": ipWhoIsResponse(7922, "US", "198.51.100.10"),
      "ipinfo.io": { ...ipinfoResponse("AS7922 Comcast"), ip: "198.51.100.10" },
    });

    const intel = await fetchIpIntelligence();
    expect(intel!.ip).toBe("198.51.100.10");
  });

  it("treats numeric ipwho.is ASN as comparable ASN across sources", async () => {
    globalThis.fetch = mockFetchBySources({
      "ipwho.is": ipWhoIsResponse(7922),
      "ipinfo.io": ipinfoResponse("AS7922 Comcast Cable"),
    });

    const intel = await fetchIpIntelligence();
    expect(intel!.asn).toBe("AS7922");
    expect(intel!.multiSourceConsistent).toBe(true);
  });

  it("flags multi-source inconsistency when exit IPs differ", async () => {
    globalThis.fetch = mockFetchBySources({
      "ipwho.is": ipWhoIsResponse(7922, "US", "203.0.113.1"),
      "ipinfo.io": { ...ipinfoResponse("AS7922 Comcast"), ip: "198.51.100.1" },
    });

    const intel = await fetchIpIntelligence();
    expect(intel!.multiSourceConsistent).toBe(false);
  });

  it("treats 200-with-success=false as source failure (fall through to ipinfo)", async () => {
    globalThis.fetch = mockFetchBySources({
      "ipwho.is": { success: false, message: "Reserved range" },
      "ipinfo.io": ipinfoResponse("AS7922 Comcast"),
    });

    const intel = await fetchIpIntelligence();
    expect(intel).not.toBeNull();
    expect(intel!.sourceCount).toBe(1);
    expect(intel!.asn).toBe("AS7922");
  });
});

describe("fetchIpIntelligence session cache (#86)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetIpIntelCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("reuses the cached value within the TTL without refetching", async () => {
    globalThis.fetch = mockFetchBySources({
      "ipwho.is": ipWhoIsResponse(7922),
      "ipinfo.io": ipinfoResponse("AS7922 Comcast"),
    });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    const first = await fetchIpIntelligence();
    expect(fetchMock).toHaveBeenCalledTimes(2); // 双源各一次
    const second = await fetchIpIntelligence();
    expect(fetchMock).toHaveBeenCalledTimes(2); // 命中缓存，无新请求
    expect(second).toEqual(first);
  });

  it("does not cache failures (null) and refetches on the next call", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    expect(await fetchIpIntelligence()).toBeNull();
    expect(await fetchIpIntelligence()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4); // 双源 × 2 次调用，均未命中缓存
  });

  it("refetches after the TTL expires", async () => {
    globalThis.fetch = mockFetchBySources({
      "ipwho.is": ipWhoIsResponse(7922),
      "ipinfo.io": ipinfoResponse("AS7922 Comcast"),
    });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await fetchIpIntelligence();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 61_000);
    await fetchIpIntelligence();
    expect(fetchMock).toHaveBeenCalledTimes(4); // TTL 过期后重取
  });

  it("deduplicates concurrent calls into a single in-flight request", async () => {
    globalThis.fetch = mockFetchBySources({
      "ipwho.is": { ...ipWhoIsResponse(7922), success: true },
      "ipinfo.io": ipinfoResponse("AS7922 Comcast"),
    });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    const [first, second] = await Promise.all([fetchIpIntelligence(), fetchIpIntelligence()]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 双源各一次，而非各调一次
    expect(first).toEqual(second);
    expect(first).not.toBeNull();
  });
});
