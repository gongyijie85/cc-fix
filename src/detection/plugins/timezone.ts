// 时区检测插件

import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";
import { readSystemTimezoneIana } from "../../platform/system-state.js";

const HIGH_RISK_TIMEZONES = ["Asia/Shanghai", "Asia/Urumqi", "Asia/Chongqing"];

export const timezonePlugin: DetectionPlugin = {
  id: "timezone",
  label: "系统时区",
  weight: 25,
  run: async (context: DetectionContext): Promise<SignalResult> => {
    // 权威读取：真实系统时区（不受常驻进程 launch-time TZ 快照影响，issue #45）
    const timezone = await readSystemTimezoneIana();
    const isHighRisk = HIGH_RISK_TIMEZONES.includes(timezone);
    const isTarget = timezone === context.targetTimezone;

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
      id: "timezone",
      label: "系统时区",
      value: timezone,
      score,
      weight: 25,
      contribution: Math.round(score * 25),
      source: "system",
      risk,
    };
  },
};