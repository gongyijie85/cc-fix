// DNS 检测插件 — 解析 Anthropic API 域名，识别污染/劫持；CDN 边缘国家不误报

import dns from "node:dns";
import { promisify } from "node:util";
import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";

const dnsLookup = promisify(dns.lookup);

/** Cloudflare 等 CDN 的公网段（Anthropic 走 CF，边缘国家 ≠ DNS 泄露） */
function isCloudflareIp(ip: string): boolean {
  // 104.16.0.0/12, 104.18 常见；172.64.0.0/13；198.41.128.0/17 等简化匹配
  if (/^104\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^172\.(6[4-9]|[7-9]\d)\./.test(ip)) return true;
  if (/^198\.41\./.test(ip)) return true;
  if (/^162\.15[8-9]\./.test(ip)) return true;
  return false;
}

/** 私网 / CGNAT / 测试网 / 代理假 IP — 视为污染或异常解析 */
function isSuspiciousPrivateOrFakeIp(ip: string): boolean {
  if (ip === "127.0.0.1" || ip.startsWith("127.")) return true;
  if (ip.startsWith("10.")) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  // RFC 2544 / 部分代理软件使用的 198.18.0.0/15 假地址
  if (/^198\.1[89]\./.test(ip)) return true;
  // CGNAT 100.64.0.0/10
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  return false;
}

export const dnsPlugin: DetectionPlugin = {
  id: "dns",
  label: "DNS 配置",
  weight: 8,
  run: async (_context: DetectionContext): Promise<SignalResult> => {
    try {
      const result = await dnsLookup("api.anthropic.com");
      const ip = result.address;

      // 假地址 / 私网：DNS 污染或本地劫持嫌疑
      if (isSuspiciousPrivateOrFakeIp(ip)) {
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
      const geoResponse = await fetch(`http://ip-api.com/json/${ip}?fields=country,countryCode,as`, {
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
        country?: string;
        countryCode?: string;
        as?: string;
      };

      // 若 geo 标明 Cloudflare ASN，同样视为 CDN
      const asStr = (geoData.as ?? "").toUpperCase();
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
        value: `api.anthropic.com → ${ip} (${geoData.country ?? geoData.countryCode ?? "未知"})`,
        score: 0,
        weight: 8,
        contribution: 0,
        source: "network",
        risk: "low",
      };
    } catch {
      // DNS 解析失败（网络不可达等）≠ DNS 泄露，跳过不加分
      return {
        id: "dns",
        label: "DNS 配置",
        value: "DNS 解析失败（可能网络不可达）",
        score: 0,
        weight: 8,
        contribution: 0,
        source: "network",
        risk: "low",
      };
    }
  },
};
