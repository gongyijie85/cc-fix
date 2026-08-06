// 检测运行器 — 协调插件执行并汇总结果

import type { DetectionPlugin, DetectionContext } from "./plugin.js";
import type { SignalResult, CheckResponse, IpIntelligence, RegionCode } from "./types.js";
import { buildCheckResponse } from "./scoring.js";
import { timezonePlugin } from "./plugins/timezone.js";
import { languagePlugin } from "./plugins/language.js";
import { localePlugin } from "./plugins/locale.js";
import { createConsistencyPlugin } from "./plugins/consistency.js";

export async function runDetection(
  regionCode: RegionCode,
  targetTimezone: string,
  targetLang: string,
  ipIntel: IpIntelligence | null
): Promise<CheckResponse> {
  const context: DetectionContext = { targetTimezone, targetLang };

  const plugins: DetectionPlugin[] = [
    timezonePlugin,
    languagePlugin,
    localePlugin,
    createConsistencyPlugin(ipIntel),
  ];

  const signals: SignalResult[] = await Promise.all(
    plugins.map((plugin) => plugin.run(context))
  );

  return buildCheckResponse(signals, ipIntel, regionCode);
}
