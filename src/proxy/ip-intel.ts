// IP 情报查询 — 多源回退，国内可用

import type { IpIntelligence } from "../detection/types.js";

type IpApiResult = {
  ip?: string;
  country?: string;
  regionName?: string;
  city?: string;
  org?: string;
  timezone?: string;
  as?: string;
};

// 源 1: ip-api.com（国内可用，免费，无需 key）
async function fetchFromIpApi(): Promise<IpIntelligence | null> {
  try {
    const response = await fetch("http://ip-api.com/json/?lang=zh-CN", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as IpApiResult & { status?: string };
    if (data.status === "fail") return null;
    return {
      ip: data.ip ?? null,
      country: data.country ?? null,
      region: data.regionName ?? null,
      city: data.city ?? null,
      asn: data.as?.split(" ")[0] ?? null,
      org: data.org ?? data.as ?? null,
      timezone: data.timezone ?? null,
    };
  } catch {
    return null;
  }
}

// 源 2: ipinfo.io（备用）
async function fetchFromIpInfo(): Promise<IpIntelligence | null> {
  try {
    const response = await fetch("https://ipinfo.io/json", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      ip?: string;
      country?: string;
      region?: string;
      city?: string;
      org?: string;
      timezone?: string;
    };
    return {
      ip: data.ip ?? null,
      country: data.country ?? null,
      region: data.region ?? null,
      city: data.city ?? null,
      asn: data.org?.split(" ")[0] ?? null,
      org: data.org ?? null,
      timezone: data.timezone ?? null,
    };
  } catch {
    return null;
  }
}

export async function fetchIpIntelligence(): Promise<IpIntelligence | null> {
  // 依次尝试多个源，任一成功即返回
  const result = (await fetchFromIpApi()) ?? (await fetchFromIpInfo());
  return result;
}
