// UTC 偏移检测插件 — 验证 TZ 环境变量是否生效

import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";

// 目标时区到预期 UTC 偏移（分钟）的映射
const EXPECTED_OFFSETS: Record<string, number> = {
  "America/New_York": -300,
  "America/Los_Angeles": -480,
  "America/Chicago": -360,
  "America/Denver": -420,
  "Europe/London": 0,
  "Europe/Berlin": 60,
  "Europe/Paris": 60,
  "Asia/Tokyo": 540,
  "Asia/Singapore": 480,
  "Asia/Hong_Kong": 480,
  "Asia/Shanghai": 480,
  "Australia/Sydney": 600,
};

export const utcOffsetPlugin: DetectionPlugin = {
  id: "utc-offset",
  label: "UTC 偏移",
  weight: 4,
  run: async (context: DetectionContext): Promise<SignalResult> => {
    const actualOffset = new Date().getTimezoneOffset(); // 分钟，正数表示 UTC 之前
    const expectedOffset = EXPECTED_OFFSETS[context.targetTimezone];

    if (expectedOffset === undefined) {
      return {
        id: "utc-offset",
        label: "UTC 偏移",
        value: `UTC${actualOffset <= 0 ? "+" : "-"}${String(Math.abs(Math.floor(actualOffset / 60))).padStart(2, "0")}:${String(Math.abs(actualOffset % 60)).padStart(2, "0")}`,
        score: 0,
        weight: 4,
        contribution: 0,
        source: "system",
        risk: "low",
      };
    }

    // 考虑夏令时：允许 ±60 分钟偏差
    const diff = Math.abs(actualOffset - expectedOffset);
    const isMatch = diff <= 60;

    const offsetStr = `UTC${actualOffset <= 0 ? "+" : "-"}${String(Math.abs(Math.floor(actualOffset / 60))).padStart(2, "0")}:${String(Math.abs(actualOffset % 60)).padStart(2, "0")}`;

    return {
      id: "utc-offset",
      label: "UTC 偏移",
      value: offsetStr,
      score: isMatch ? 0 : 1,
      weight: 4,
      contribution: isMatch ? 0 : 4,
      source: "system",
      risk: isMatch ? "low" : "medium",
    };
  },
};
