// IP 情报派生信号（评审候选 9）— 与其余信号共享 DetectionPlugin seam，运行器只编排。

import type { DetectionPlugin } from "../plugin.js";
import type { IpIntelligence, SignalResult } from "../types.js";

function datacenterSignal(ipIntel: IpIntelligence): SignalResult {
  return {
    id: "ip-datacenter",
    label: "数据中心 IP",
    value: ipIntel.asn + " (" + (ipIntel.org || "未知") + ")",
    score: 1,
    weight: 13,
    contribution: 13,
    source: "network",
    risk: "high",
  };
}

function multiSourceSignal(ipIntel: IpIntelligence): SignalResult {
  return {
    id: "ip-multi-source",
    label: "多源不一致",
    value: ipIntel.sourceCount + " 个情报源结果不一致",
    score: 1,
    weight: 15,
    contribution: 15,
    source: "network",
    risk: "high",
  };
}

/** 0-2 个 IP 派生插件；信号字段与事件行为与旧内联实现逐字节一致。 */
export function createIpIntelligencePlugins(ipIntel: IpIntelligence | null): DetectionPlugin[] {
  if (ipIntel === null) return [];
  const plugins: DetectionPlugin[] = [];
  if (ipIntel.ipType === "datacenter") {
    plugins.push({ id: "ip-datacenter", label: "数据中心 IP", weight: 13, run: async () => datacenterSignal(ipIntel) });
  }
  if (!ipIntel.multiSourceConsistent) {
    plugins.push({ id: "ip-multi-source", label: "多源不一致", weight: 15, run: async () => multiSourceSignal(ipIntel) });
  }
  return plugins;
}
