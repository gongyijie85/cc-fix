// Locale 检测插件

import { createScalarConsistencyPlugin } from "./scalar-consistency.js";
import { readUserLocale } from "../../platform/system-state.js";

const HIGH_RISK_LOCALES = ["zh-CN", "zh-Hans", "zh_CN"];

export const localePlugin = createScalarConsistencyPlugin({
  id: "locale",
  label: "Intl Locale",
  weight: 6,
  // 权威读取：Windows 区域格式（注册表 LocaleName）优先，回退 ICU 解析（issue #45）
  read: async () => (await readUserLocale()) || Intl.DateTimeFormat().resolvedOptions().locale,
  isHighRisk: (value) => HIGH_RISK_LOCALES.some((hl) => value.includes(hl)),
  isTarget: (value, context) => value.includes(context.targetLang.split("_")[0] ?? ""),
});
