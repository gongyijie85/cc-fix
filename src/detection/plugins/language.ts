// 语言检测插件

import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";
import { readUserEnvVar } from "../../platform/system-state.js";

const HIGH_RISK_LANGUAGES = ["zh_CN", "zh-CN", "zh_CN.UTF-8", "zh_CN.UTF8"];

export const languagePlugin: DetectionPlugin = {
  id: "language",
  label: "系统语言",
  weight: 20,
  run: async (context: DetectionContext): Promise<SignalResult> => {
    // 权威读取：注册表环境变量优先（persist 的写入目标），非 Windows 回退进程 env（issue #45）
    const lang = (await readUserEnvVar("LANG")) || (await readUserEnvVar("LC_ALL")) || process.env.LANG || process.env.LANGUAGE || process.env.LC_ALL || "unknown";
    const isHighRisk = HIGH_RISK_LANGUAGES.some((hl) => lang.includes(hl));
    const isTarget = lang.includes(context.targetLang.split(".")[0]);

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
      id: "language",
      label: "系统语言",
      value: lang,
      score,
      weight: 20,
      contribution: Math.round(score * 20),
      source: "system",
      risk,
    };
  },
};