// 检测运行器 — 协调插件执行并汇总结果

import type { DetectionPlugin, DetectionContext } from "./plugin.js";
import type { SignalResult, CheckResponse, IpIntelligence, RegionCode } from "./types.js";
import { buildCheckResponse } from "./scoring.js";
import { timezonePlugin } from "./plugins/timezone.js";
import { languagePlugin } from "./plugins/language.js";
import { localePlugin } from "./plugins/locale.js";
import { createConsistencyPlugin } from "./plugins/consistency.js";
import { dnsPlugin } from "./plugins/dns.js";
import { fontsPlugin } from "./plugins/fonts.js";
import { baseUrlPlugin } from "./plugins/base-url.js";
import { proxyPlugin } from "./plugins/proxy.js";
import { winRegionPlugin } from "./plugins/win-region.js";
import { utcOffsetPlugin } from "./plugins/utc-offset.js";

export async function runDetection(
  regionCode: RegionCode,
  targetTimezone: string,
  targetLang: string,
  ipIntel: IpIntelligence | null
): Promise<CheckResponse> {
  const context: DetectionContext = { targetTimezone, targetLang };

  // 10 个检测插件：4 高优(Phase 1) + 6 中优(Phase 2)
  const plugins: DetectionPlugin[] = [
    // Phase 1 — 高优
    timezonePlugin,
    languagePlugin,
    localePlugin,
    createConsistencyPlugin(ipIntel),
    // Phase 2 — 中优
    fontsPlugin,
    dnsPlugin,
    baseUrlPlugin,
    proxyPlugin,
    winRegionPlugin,
    utcOffsetPlugin,
  ];

  const signals: SignalResult[] = await Promise.all(
    plugins.map((plugin) => plugin.run(context))
  );

  // IP 情报派生信号（参与评分）
  if (ipIntel) {
    if (ipIntel.ipType === "datacenter") {
      signals.push({
        id: "ip-datacenter",
        label: "数据中心 IP",
        value: `${ipIntel.asn} (${ipIntel.org || "未知"})`,
        score: 1,
        weight: 13,
        contribution: 13,
        source: "network",
        risk: "high",
      });
    }
    if (!ipIntel.multiSourceConsistent) {
      signals.push({
        id: "ip-multi-source",
        label: "多源不一致",
        value: `${ipIntel.sourceCount} 个情报源结果不一致`,
        score: 1,
        weight: 15,
        contribution: 15,
        source: "network",
        risk: "high",
      });
    }
  }

  return buildCheckResponse(signals, ipIntel, regionCode);
}
