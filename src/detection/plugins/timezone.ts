// 时区检测插件

import { createScalarConsistencyPlugin } from "./scalar-consistency.js";
import { systemState } from "../../platform/system-state.js";

const HIGH_RISK_TIMEZONES = ["Asia/Shanghai", "Asia/Urumqi", "Asia/Chongqing"];

export const timezonePlugin = createScalarConsistencyPlugin({
  id: "timezone",
  label: "系统时区",
  weight: 25,
  // 权威读取：真实系统时区（不受常驻进程 launch-time TZ 快照影响，issue #45）
  read: async () => (await systemState()).timezone,
  isHighRisk: (value) => HIGH_RISK_TIMEZONES.includes(value),
  isTarget: (value, context) => value === context.targetTimezone,
});
