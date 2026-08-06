// IP 情报查询 — 多源对比 + 数据中心判断

import type { IpIntelligence } from "../detection/types.js";

// 常见云厂商 ASN 前缀（数据中心 IP）
const DATACENTER_ASN_PREFIXES = [
  "AS16509",  // AWS
  "AS14618",  // AWS
  "AS8075",   // Azure
  "AS15169",  // Google
  "AS396982", // Google Cloud
  "AS13335",  // Cloudflare
  "AS14061",  // DigitalOcean
  "AS37963",  // 阿里云
  "AS45090",  // 腾讯云
  "AS36351",  // SoftLayer
  "AS20473",  // Vultr
  "AS63949",  // Linode/Akamai
  "AS51167",  // Contabo
  "AS9009",   // M247
  "AS212238", // Datacamp Limited
];

type RawIpData = {
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  asn: string | null;
  org: string | null;
  timezone: string | null;
};

type IpApiResult = {
  ip?: string;
  country?: string;
  regionName?: string;
  city?: string;
  org?: string;
  timezone?: string;
  as?: string;
};

function isDatacenterAsn(asn: string | null): boolean {
  if (!asn) return false;
  // 精确匹配：提取 ASN 前缀（如 "AS16509 Amazon" → "AS16509"）
  const asnPrefix = asn.split(/\s+/)[0];
  return DATACENTER_ASN_PREFIXES.includes(asnPrefix);
}

// 源 1: ip-api.com（国内可用，免费，无需 key）
async function fetchFromIpApi(): Promise<RawIpData | null> {
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
async function fetchFromIpInfo(): Promise<RawIpData | null> {
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

function toIpIntelligence(
  primary: RawIpData,
  secondary: RawIpData | null
): IpIntelligence {
  // 多源一致性检查
  let multiSourceConsistent = true;
  let sourceCount = 1;

  if (secondary) {
    sourceCount = 2;
    const countryMatch =
      !primary.country || !secondary.country ||
      primary.country.toUpperCase() === secondary.country.toUpperCase();
    const asnMatch =
      !primary.asn || !secondary.asn ||
      primary.asn === secondary.asn;
    multiSourceConsistent = countryMatch && asnMatch;
  }

  // 数据中心判断
  const ipType = isDatacenterAsn(primary.asn)
    ? "datacenter" as const
    : primary.asn
      ? "residential" as const
      : "unknown" as const;

  return {
    ip: primary.ip,
    country: primary.country,
    region: primary.region,
    city: primary.city,
    asn: primary.asn,
    org: primary.org,
    timezone: primary.timezone,
    ipType,
    multiSourceConsistent,
    sourceCount,
  };
}

export async function fetchIpIntelligence(): Promise<IpIntelligence | null> {
  // 并行查询多个源
  const [primary, secondary] = await Promise.all([
    fetchFromIpApi(),
    fetchFromIpInfo(),
  ]);

  if (primary) {
    return toIpIntelligence(primary, secondary);
  }
  if (secondary) {
    return toIpIntelligence(secondary, null);
  }
  return null;
}
