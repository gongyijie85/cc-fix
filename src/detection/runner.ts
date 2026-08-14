// 检测运行器 — 协调插件执行并汇总结果

import type { DetectionPlugin, DetectionContext } from "./plugin.js";
import type { SignalResult, CheckResponse, IpIntelligence, AccessRegionCode } from "./types.js";
import type { EventConsumer } from "../events/types.js";
import { buildCheckResponse } from "./scoring.js";
import { resetSystemState } from "../platform/system-state.js";
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
import { browserPolicyPlugin } from "./plugins/browser-policy.js";
import { createIpIntelligencePlugins } from "./plugins/ip-intel.js";

export async function runDetection(
  regionCode: AccessRegionCode,
  targetTimezone: string,
  targetLang: string,
  ipIntel: IpIntelligence | null,
  onEvent?: EventConsumer,
): Promise<CheckResponse> {
  const context: DetectionContext = { targetTimezone, targetLang };

  // 每次检测重新读取系统状态（时区/偏移可能在两次检测之间被 persist 改变）
  resetSystemState();

  // 阶段：IP 情报
  if (onEvent) onEvent({ type: "phase", label: "正在获取 IP 情报…" });
  if (onEvent) onEvent({ type: "detect-start" });

  // 11 个检测插件：4 高优(Phase 1) + 6 中优(Phase 2) + 浏览器策略(ADR-0003)
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
    // ADR-0003 — 浏览器策略就位信号
    browserPolicyPlugin,
    // IP 情报派生信号（与其余信号共享插件 seam）
    ...createIpIntelligencePlugins(ipIntel),
  ];

  // 逐个故障隔离：单个插件失败时发射降级事件，不阻断其余插件
  const results = await Promise.all(
    plugins.map(async (plugin) => {
      try {
        const result = await plugin.run(context);
        if (onEvent) onEvent({ type: "detect-ok", signal: result });
        return result;
      } catch (err) {
        if (onEvent)
          onEvent({
            type: "detect-degraded",
            pluginId: plugin.id,
            error: err instanceof Error ? err.message : String(err),
          });
        return null;
      }
    })
  );
  const signals: SignalResult[] = results.filter((r): r is SignalResult => r !== null);

  const response = buildCheckResponse(signals, ipIntel, regionCode);
  if (onEvent) onEvent({ type: "detect-done", response });
  return response;
}