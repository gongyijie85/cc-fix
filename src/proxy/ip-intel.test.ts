// IP 情报增强测试 — 多源一致性 + 数据中心 ASN 判断

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchIpIntelligence } from "./ip-intel.js";

function ipApiResponse(asStr: string, countryCode = "US") {
  return {
    status: "success",
    ip: "203.0.113.1",
    country: "United States",
    countryCode,
    regionName: "California",
    city: "Los Angeles",
    as: asStr,
    org: undefined,
    timezone: "America/Los_Angeles",
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

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("detects datacenter IP by cloud ASN prefix", async () => {
    globalThis.fetch = mockFetchBySources({
      "ip-api.com": ipApiResponse("AS16509 Amazon.com, Inc."),
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
      "ip-api.com": ipApiResponse("AS7922 Comcast Cable Communications"),
      "ipinfo.io": ipinfoResponse("AS7922 Comcast Cable Communications"),
    });

    const intel = await fetchIpIntelligence();
    expect(intel!.ipType).toBe("residential");
    expect(intel!.multiSourceConsistent).toBe(true);
  });

  it("flags multi-source inconsistency on country mismatch", async () => {
    globalThis.fetch = mockFetchBySources({
      "ip-api.com": ipApiResponse("AS7922 Comcast", "US"),
      "ipinfo.io": ipinfoResponse("AS7922 Comcast Cable", "JP"),
    });

    const intel = await fetchIpIntelligence();
    expect(intel!.multiSourceConsistent).toBe(false);
    expect(intel!.sourceCount).toBe(2);
  });

  it("flags multi-source inconsistency on ASN mismatch", async () => {
    globalThis.fetch = mockFetchBySources({
      "ip-api.com": ipApiResponse("AS7922 Comcast"),
      "ipinfo.io": ipinfoResponse("AS16509 Amazon"),
    });

    const intel = await fetchIpIntelligence();
    expect(intel!.multiSourceConsistent).toBe(false);
  });

  it("falls back to single source when secondary fails", async () => {
    globalThis.fetch = mockFetchBySources({
      "ip-api.com": ipApiResponse("AS7922 Comcast"),
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
});
