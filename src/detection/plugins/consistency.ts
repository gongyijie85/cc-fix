// 信号一致性检测插件

import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";
import type { IpIntelligence } from "../types.js";
import { readUserLocale, systemState } from "../../platform/system-state.js";
import { isCorporateIp, isCorporateAsn } from "../corporate-allowlist.js";

/** EU 目标允许的出口国家集合（英国脱欧后仍归欧洲画像；企业内网另走白名单豁免）。 */
const EU_COUNTRIES = new Set([
  "GB", "IE", "FR", "DE", "NL", "BE", "LU", "AT", "CH", "IT", "ES", "PT",
  "DK", "SE", "NO", "FI", "PL", "CZ", "SK", "HU", "RO", "GR", "HR", "SI",
  "EE", "LV", "LT", "BG", "CY", "MT",
]);

type TargetGeography =
  | { kind: "country"; code: string; label: string }
  | { kind: "area"; countries: ReadonlySet<string>; label: string };

/** 目标时区 → 期望出口地理。与 detection/regions.ts 的 TARGET_REGIONS 时区一一对应。 */
const GEO_BY_TARGET_TIMEZONE: Readonly<Record<string, TargetGeography>> = {
  "America/New_York": { kind: "country", code: "US", label: "US" },
  "Asia/Tokyo": { kind: "country", code: "JP", label: "JP" },
  "Asia/Singapore": { kind: "country", code: "SG", label: "SG" },
  "Europe/London": { kind: "area", countries: EU_COUNTRIES, label: "EU" },
};

export function createConsistencyPlugin(ipIntel: IpIntelligence | null): DetectionPlugin {
  return {
    id: "consistency",
    label: "信号一致性",
    weight: 15,
    run: async (context: DetectionContext): Promise<SignalResult> => {
      // 权威读取（issue #45）：真实系统时区与用户 Locale，而非常驻进程的 launch-time 快照
      const timezone = (await systemState()).timezone;
      const locale = (await readUserLocale()) ?? Intl.DateTimeFormat().resolvedOptions().locale;
      const ipCountry = ipIntel?.country?.toUpperCase();

      const signals: string[] = [];
      let inconsistencies = 0;

      // 检查时区与目标地区是否一致
      if (timezone !== context.targetTimezone) {
        inconsistencies++;
        signals.push(`时区(${timezone})≠目标(${context.targetTimezone})`);
      }

      // 检查 locale 与目标语言是否一致
      if (!locale.includes(context.targetLang.split("_")[0] ?? "")) {
        inconsistencies++;
        signals.push(`Locale(${locale})≠目标(${context.targetLang})`);
      }

      // 检查 IP 国家与目标地区是否一致（如果有 IP 信息且目标时区在目录内）
      // 企业白名单内的 IP/ASN 不计入不一致（办公VPN豁免）
      // #106：us/jp/sg 按期望国家精确比较；eu 目标接受欧洲国家集合，不再只校验 US。
      const geography = GEO_BY_TARGET_TIMEZONE[context.targetTimezone];
      if (ipCountry && ipIntel && geography !== undefined) {
        const corporate = (ipIntel?.ip && await isCorporateIp(ipIntel.ip)) || (ipIntel?.asn && await isCorporateAsn(ipIntel.asn));
        if (corporate) {
          signals.push(`IP(${ipCountry}) 为企业白名单，已豁免`);
        } else {
          const mismatch = geography.kind === "country"
            ? ipCountry !== geography.code
            : !geography.countries.has(ipCountry);
          if (mismatch) {
            inconsistencies++;
            signals.push(`IP(${ipCountry})≠目标(${geography.label})`);
          }
        }
      }

      let score = 0;
      let risk: SignalResult["risk"] = "low";

      if (inconsistencies >= 2) {
        score = 1;
        risk = "high";
      } else if (inconsistencies === 1) {
        score = 0.5;
        risk = "medium";
      }

      return {
        id: "consistency",
        label: "信号一致性",
        value: inconsistencies > 0 || signals.length > 0 ? signals.join("; ") : "一致",
        score,
        weight: 15,
        contribution: Math.round(score * 15),
        source: "combined",
        risk,
      };
    },
  };
}