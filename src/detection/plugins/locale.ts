// Locale 检测插件

import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";
import { readUserLocale } from "../../platform/system-state.js";

const HIGH_RISK_LOCALES = ["zh-CN", "zh-Hans", "zh_CN"];

export const localePlugin: DetectionPlugin = {
  id: "locale",
  label: "Intl Locale",
  weight: 6,
  run: async (context: DetectionContext): Promise<SignalResult> => {
    // 权威读取：Windows 区域格式（注册表 LocaleName）优先，回退 ICU 解析（issue #45）
    const locale = (await readUserLocale()) || Intl.DateTimeFormat().resolvedOptions().locale;
    const isHighRisk = HIGH_RISK_LOCALES.some((hl) => locale.includes(hl));
    const isTarget = locale.includes(context.targetLang.split("_")[0] ?? "");

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