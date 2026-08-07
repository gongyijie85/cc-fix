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
  /** ip-api.com 用 query 字段表示出口 IP，不是 ip */
  query?: string;
  ip?: string;
  country?: string;
  countryCode?: string;
  regionName?: string;
  city?: string;
  org?: string;
  timezone?: string;
  as?: string;
};

/** 归一化 ASN 为 AS12345，避免 "AS16509 Amazon" vs "AS16509" 误判不一致 */
export function normalizeAsn(asn: string | null | undefined): string | null {
  if (!asn) return null;
  const match = asn.toUpperCase().match(/AS\d+/);
  return match ? match[0] : null;
}

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
      // ip-api.com 官方字段是 query；兼容错误文档里的 ip
      ip: data.query ?? data.ip ?? null,
      // 统一用 ISO 国家码（ip-api 的 country 是本地化全名，与 ipinfo 的 ISO 码无法直接对比）
      country: data.countryCode ?? null,
      region: data.regionName ?? null,
      city: data.city ?? null,
      asn: normalizeAsn(data.as),
      org: data.org || data.as || null,
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
      asn: normalizeAsn(data.org),
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
    const primaryAsn = normalizeAsn(primary.asn);
    const secondaryAsn = normalizeAsn(secondary.asn);
    const asnMatch =
      !primaryAsn || !secondaryAsn || primaryAsn === secondaryAsn;
    // 出口 IP 本身不一致（不同源看到不同地址）也算多源冲突
    const ipMatch =
      !primary.ip || !secondary.ip || primary.ip === secondary.ip;
    multiSourceConsistent = countryMatch && asnMatch && ipMatch;
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
