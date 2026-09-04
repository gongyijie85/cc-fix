// DNS 检测插件 — 解析 Anthropic API 域名，识别污染/劫持；CDN 边缘国家不误报

import dns from "node:dns";
import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";

/** 单次 DNS 解析的硬超时：坏/慢 DNS（丢包黑洞、VPN 残留 DNS）不得拖住整个检测流 */
const DNS_LOOKUP_TIMEOUT_MS = 5000;

export type DnsLookupFn = (
  host: string,
  options: { signal?: AbortSignal },
) => Promise<{ address: string; family: number }>;

function defaultLookup(host: string, options: { signal?: AbortSignal }): Promise<{ address: string; family: number }> {
  return new Promise((resolve, reject) => {
    // signal 在 Node ≥18.18 的 dns.lookup 中受支持；@types/node 20 尚未收录该字段，此处断言绕过。
    // 即便运行时不响应 abort，lookupWithTimeout 的竞速也会在超时后放弃。
    const lookupOptions = { signal: options.signal } as unknown as dns.LookupOneOptions;
    dns.lookup(host, lookupOptions, (error, address: string, family: number) => {
      if (error) { reject(error); return; }
      resolve({ address, family });
    });
  });
}

/**
 * 带超时的解析：即使底层 lookup 不响应 abort，也通过竞速在超时后放弃，
 * 保证调用方永远不会被一个卡死的解析无限阻塞。
 */
async function lookupWithTimeout(
  host: string,
  lookup: DnsLookupFn,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`DNS 解析超时（${timeoutMs}ms）`)), timeoutMs);
  try {
    return await Promise.race([
      lookup(host, { signal: controller.signal }).then((result) => result.address),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Cloudflare 等 CDN 的公网段（Anthropic 走 CF，边缘国家 ≠ DNS 泄露） */
function isCloudflareIp(ip: string): boolean {
  // 104.16.0.0/12, 104.18 常见；172.64.0.0/13；198.41.128.0/17 等简化匹配
  if (/^104\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^172\.(6[4-9]|[7-9]\d)\./.test(ip)) return true;
  if (/^198\.41\./.test(ip)) return true;
  if (/^162\.15[8-9]\./.test(ip)) return true;
  return false;
}

/** Clash / mihomo fake-ip 默认网段 198.18.0.0/16（正常接管，不是污染） */
function isClashFakeIp(ip: string): boolean {
  return /^198\.18\./.test(ip);
}

/** 私网 / CGNAT — 真异常（非 Clash fake-ip） */
function isSuspiciousPrivateIp(ip: string): boolean {
  if (ip === "127.0.0.1" || ip.startsWith("127.")) return true;
  if (ip.startsWith("10.")) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  // CGNAT 100.64.0.0/10
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  // 198.19.x 等非 Clash 常见假网段仍标可疑
  if (/^198\.19\./.test(ip)) return true;
  return false;
}

export function createDnsPlugin(
  lookup: DnsLookupFn = defaultLookup,
  timeoutMs: number = DNS_LOOKUP_TIMEOUT_MS,
): DetectionPlugin {
  return {
    id: "dns",
    label: "DNS 配置",
    weight: 8,
    run: async (_context: DetectionContext): Promise<SignalResult> => {
      try {
        const ip = await lookupWithTimeout("api.anthropic.com", lookup, timeoutMs);

      // Clash fake-ip：解析进 198.18.0.0/16 表示域名已由代理接管（Merlin Clash / mihomo 正常行为）
      if (isClashFakeIp(ip)) {
        return {
          id: "dns",
          label: "DNS 配置",
          value: `api.anthropic.com → ${ip}（Clash fake-ip，代理已接管）`,
          score: 0,
          weight: 8,
          contribution: 0,
          source: "network",
          risk: "low",
        };
      }

      // 其它私网：DNS 污染或本地劫持嫌疑
      if (isSuspiciousPrivateIp(ip)) {
        return {
          id: "dns",
          label: "DNS 配置",
          value: `api.anthropic.com → ${ip}（疑似污染/假地址）`,
          score: 0.75,
          weight: 8,
          contribution: 6,
          source: "network",
          risk: "medium",
        };
      }

      // Cloudflare CDN：边缘国家随 POP 变化，不按国家对比打分
      if (isCloudflareIp(ip)) {
        return {
          id: "dns",
          label: "DNS 配置",
          value: `api.anthropic.com → ${ip}（Cloudflare CDN）`,
          score: 0,
          weight: 8,
          contribution: 0,
          source: "network",
          risk: "low",
        };
      }

      // 其他公网 IP：仅作展示，geo 失败则安全；geo 成功也不再因「非 US」加分
      // （Anthropic 解析结果常非 US 边缘，国家码不能当 DNS 泄露证据）
      // 全 HTTPS 收口（#70 决议）：ip-api.com 明文 HTTP → ipwho.is
      const geoResponse = await fetch(`https://ipwho.is/${ip}`, {
        signal: AbortSignal.timeout(3000),
      });

      if (!geoResponse.ok) {
        return {
          id: "dns",
          label: "DNS 配置",
          value: `api.anthropic.com → ${ip} (无法查询地理位置)`,
          score: 0,
          weight: 8,
          contribution: 0,
          source: "network",
          risk: "low",
        };
      }

      const geoData = (await geoResponse.json()) as {
        success?: boolean;
        country?: string;
        country_code?: string;
        connection?: { asn?: number; org?: string };
      };

      if (geoData.success === false) {
        return {
          id: "dns",
          label: "DNS 配置",
          value: `api.anthropic.com → ${ip} (无法查询地理位置)`,
          score: 0,
          weight: 8,
          contribution: 0,
          source: "network",
          risk: "low",
        };
      }

      // 若 geo 标明 Cloudflare ASN，同样视为 CDN（ipwho.is 的 asn 是数值，如 13335）
      const asStr = `${geoData.connection?.asn !== undefined ? `AS${geoData.connection.asn}` : ""} ${geoData.connection?.org ?? ""}`.toUpperCase();
      if (asStr.includes("AS13335") || asStr.includes("CLOUDFLARE")) {
        return {
          id: "dns",
          label: "DNS 配置",
          value: `api.anthropic.com → ${ip}（Cloudflare CDN）`,
          score: 0,
          weight: 8,
          contribution: 0,
          source: "network",
          risk: "low",
        };
      }

      return {
        id: "dns",
        label: "DNS 配置",
        value: `api.anthropic.com → ${ip} (${geoData.country ?? geoData.country_code ?? "未知"})`,
        score: 0,
        weight: 8,
        contribution: 0,
        source: "network",
        risk: "low",
      };
    } catch {
      // #117：解析失败/超时 = 检测受限，≠ 安全结论。不能以 low 误导"DNS 无风险"；
      // 不参与加分（非 DNS 泄露证据），但呈现为中风险提示并引导联网复测。
      return {
        id: "dns",
        label: "DNS 配置",
        value: "DNS 解析失败或超时（检测受限，不能视为安全）— 请检查网络连接后重跑 `cc-fix check`",
        score: 0,
        weight: 8,
        contribution: 0,
        source: "network",
        risk: "medium",
      };
    }
    },
  };
}

/** 默认实例：真实 dns.lookup + 5s 硬超时 */
export const dnsPlugin = createDnsPlugin();
