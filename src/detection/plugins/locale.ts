// Locale 检测插件

import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";

const HIGH_RISK_LOCALES = ["zh-CN", "zh-Hans", "zh_CN"];

export const localePlugin: DetectionPlugin = {
  id: "locale",
  label: "Intl Locale",
  weight: 6,
  run: async (context: DetectionContext): Promise<SignalResult> => {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    const isHighRisk = HIGH_RISK_LOCALES.some((hl) => locale.includes(hl));
    const isTarget = locale.includes(context.targetLang.split("_")[0]);

    let score = 0;
    let risk: SignalResult["risk"] = "low";

    if (isHighRisk) {
      score = 1;
      risk = "high";
    } else if (!isTarget) {
      score = 0.5;
      risk = "medium";
    }

    return {
      id: "locale",
      label: "Intl Locale",
      value: locale,
      score,
      weight: 6,
      contribution: Math.round(score * 6),
      source: "system",
      risk,
    };
  },
};
