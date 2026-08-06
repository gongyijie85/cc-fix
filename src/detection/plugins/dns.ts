// DNS 检测插件 — 解析 Anthropic API 域名，对比 IP 所在国家

import dns from "node:dns";
import { promisify } from "node:util";
import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";

const dnsLookup = promisify(dns.lookup);

// 目标地区到预期国家代码的映射
const REGION_COUNTRY_MAP: Record<string, string[]> = {
  "America/New_York": ["US"],
  "America/Los_Angeles": ["US"],
  "America/Chicago": ["US"],
  "Europe/London": ["GB", "UK"],
  "Europe/Berlin": ["DE"],
  "Asia/Tokyo": ["JP"],
  "Asia/Singapore": ["SG"],
};

export const dnsPlugin: DetectionPlugin = {
  id: "dns",
  label: "DNS 配置",
  weight: 8,
  run: async (context: DetectionContext): Promise<SignalResult> => {
    try {
      const result = await dnsLookup("api.anthropic.com");
      const ip = result.address;

      // 用 ip-api.com 查询 IP 所在国家
      const geoResponse = await fetch(`http://ip-api.com/json/${ip}?fields=country,countryCode`, {
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
      };

      const countryCode = geoData.countryCode?.toUpperCase() ?? "";
      const expectedCountries = REGION_COUNTRY_MAP[context.targetTimezone] ?? ["US"];
      const isConsistent = expectedCountries.includes(countryCode);

      return {
        id: "dns",
        label: "DNS 配置",
        value: `api.anthropic.com → ${ip} (${geoData.country})`,
        score: isConsistent ? 0 : 0.5,
        weight: 8,
        contribution: isConsistent ? 0 : 4,
        source: "network",
        risk: isConsistent ? "low" : "medium",
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
