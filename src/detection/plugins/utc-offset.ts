// UTC 偏移检测插件 — 验证 TZ 环境变量是否生效

import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";
import { systemState } from "../../platform/system-state.js";

// 目标时区到预期 UTC 偏移（分钟，带符号：西为负，如纽约冬令时 -300）的映射
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

function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${h}:${m}`;
}

export const utcOffsetPlugin: DetectionPlugin = {
  id: "utc-offset",
  label: "UTC 偏移",
  weight: 4,
  run: async (context: DetectionContext): Promise<SignalResult> => {
    // getTimezoneOffset 的符号与 UTC 偏移相反（西为正），取反得到带符号偏移
    // 权威读取：真实系统时区的当前偏移（不受 launch-time TZ 快照影响，issue #45）
    const actualOffset = (await systemState()).offsetMinutes;
    const expectedOffset = EXPECTED_OFFSETS[context.targetTimezone];
    const offsetStr = formatUtcOffset(actualOffset);

    if (expectedOffset === undefined) {
      return {
        id: "utc-offset",
        label: "UTC 偏移",
        value: offsetStr,
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