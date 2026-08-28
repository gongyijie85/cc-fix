// 信号一致性检测插件

import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";
import type { IpIntelligence } from "../types.js";
import { readUserLocale, systemState } from "../../platform/system-state.js";

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

      // 检查 IP 国家与目标地区是否一致（如果有 IP 信息）
      if (ipCountry && context.targetTimezone.includes("New_York") && ipCountry !== "US") {
        inconsistencies++;
        signals.push(`IP(${ipCountry})≠目标(US)`);
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
        value: inconsistencies > 0 ? signals.join("; ") : "一致",
        score,
        weight: 15,
        contribution: Math.round(score * 15),
        source: "combined",
        risk,
      };
    },
  };
}