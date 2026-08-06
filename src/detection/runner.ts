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

  return buildCheckResponse(signals, ipIntel, regionCode);
}
