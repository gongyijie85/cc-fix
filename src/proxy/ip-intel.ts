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

type IpWhoIsResult = {
  ip?: string;
  success?: boolean;
  country?: string;
  country_code?: string;
  region?: string;
  city?: string;
  connection?: { asn?: number; org?: string };
  timezone?: { id?: string };
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
  const asnPrefix = asn.split(/\s+/)[0] ?? "";
  return DATACENTER_ASN_PREFIXES.includes(asnPrefix);
}

async function isCorporateDatacenterSuppressed(asn: string | null): Promise<boolean> {
  if(!asn) return false;
  try {
    const { isCorporateAsn } = await import("../detection/corporate-allowlist.js");
    return await isCorporateAsn(asn);
  } catch { return false; }
}

// 源 1: ipwho.is（HTTPS、免 key、1000 次/天/客户端 IP；ADR-0016 决策：全 HTTPS 收口）
async function fetchFromIpWhoIs(): Promise<RawIpData | null> {
  try {
    const response = await fetch("https://ipwho.is/?fields=ip,country,country_code,region,city,connection,timezone", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as IpWhoIsResult & { message?: string };
    if (data.success === false) return null;
    return {
      ip: data.ip ?? null,
      // ipwho.is 的 country 是本地化全名（如 "Singapore"），统一用 ISO 国家码（与 ipinfo 的 ISO 码可比）
      country: data.country_code ?? null,
      region: data.region ?? null,
      city: data.city ?? null,
      asn: data.connection?.asn !== undefined ? normalizeAsn(`AS${data.connection.asn}`) : null,
      org: data.connection?.org ?? null,
      timezone: data.timezone?.id ?? null,
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

async function toIpIntelligence(
  primary: RawIpData,
  secondary: RawIpData | null
): Promise<IpIntelligence> {
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
    // 企业办公网多源抖动（公司DNS vs 公网）降噪：若任一源为企业 ASN，忽略多源不一致
    try {
      const { isCorporateAsn } = await import("../detection/corporate-allowlist.js");
      if(await isCorporateAsn(primary.asn) || await isCorporateAsn(secondary.asn)){
        multiSourceConsistent = true;
      }
    } catch {}
  }

  // 数据中心判断（企业 ASN 豁免）
  let isDC = isDatacenterAsn(primary.asn);
  if(isDC){
    if(await isCorporateDatacenterSuppressed(primary.asn)) isDC = false;
  }
  const ipType = isDC
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

/** 会话级 IP 情报缓存：GUI 检测链路的 344ms 首事件瓶颈（#86 决议：TTL 60s 预取复用）。
 * CLI 为单进程短生命周期，行为无感知。 */
const IP_INTEL_CACHE_TTL_MS = 60_000;
let ipIntelCache: { value: IpIntelligence | null; expiresAt: number } | undefined;
/** in-flight 去重：attachSse 预热与 check/start 同时到来时共享一次请求。 */
let ipIntelInFlight: Promise<IpIntelligence | null> | undefined;

/** 测试隔离：清空会话级缓存与 in-flight。 */
export function resetIpIntelCache(): void {
  ipIntelCache = undefined;
  ipIntelInFlight = undefined;
}

export async function fetchIpIntelligence(): Promise<IpIntelligence | null> {
  if (ipIntelCache !== undefined && Date.now() < ipIntelCache.expiresAt) return ipIntelCache.value;
  if (ipIntelInFlight !== undefined) return ipIntelInFlight;
  ipIntelInFlight = (async () => {
    try {
      // 并行查询多个源
      const [primary, secondary] = await Promise.all([
        fetchFromIpWhoIs(),
        fetchFromIpInfo(),
      ]);

      let intel: IpIntelligence | null = null;
      if (primary) {
        intel = await toIpIntelligence(primary, secondary);
      } else if (secondary) {
        intel = await toIpIntelligence(secondary, null);
      }
      // 失败（null）不缓存：#86 决议——失败不污染缓存，下次调用重取。
      ipIntelCache = intel === null ? undefined : { value: intel, expiresAt: Date.now() + IP_INTEL_CACHE_TTL_MS };
      return intel;
    } finally {
      ipIntelInFlight = undefined;
    }
  })();
  return ipIntelInFlight;
}
