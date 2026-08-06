// BASE_URL 域名检测插件 — 检查 ANTHROPIC_BASE_URL 是否包含敏感域名

import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";
import { isSensitiveDomain } from "../config/sensitive-domains.js";

export const baseUrlPlugin: DetectionPlugin = {
  id: "base-url",
  label: "BASE_URL 域名",
  weight: 8,
  run: async (_context: DetectionContext): Promise<SignalResult> => {
    const baseUrl = process.env.ANTHROPIC_BASE_URL;

    if (!baseUrl) {
      return {
        id: "base-url",
        label: "BASE_URL 域名",
        value: "(未设置)",
        score: 0,
        weight: 8,
        contribution: 0,
        source: "system",
        risk: "low",
      };
    }

    const isSensitive = isSensitiveDomain(baseUrl);

    return {
      id: "base-url",
      label: "BASE_URL 域名",
      value: baseUrl,
      score: isSensitive ? 1 : 0,
      weight: 8,
      contribution: isSensitive ? 8 : 0,
      source: "system",
      risk: isSensitive ? "high" : "low",
    };
  },
};
