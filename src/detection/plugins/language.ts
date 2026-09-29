// 语言检测插件

import { createScalarConsistencyPlugin } from "./scalar-consistency.js";
import { readUserEnvVar } from "../../platform/system-state.js";

const HIGH_RISK_LANGUAGES = ["zh_CN", "zh-CN", "zh_CN.UTF-8", "zh_CN.UTF8"];

export const languagePlugin = createScalarConsistencyPlugin({
  id: "language",
  label: "系统语言",
  weight: 20,
  // 权威读取：注册表环境变量优先（persist 的写入目标），非 Windows 回退进程 env（issue #45）
  read: async () =>
    (await readUserEnvVar("LANG")) || (await readUserEnvVar("LC_ALL")) || process.env.LANG || process.env.LANGUAGE || process.env.LC_ALL || "unknown",
  isHighRisk: (value) => HIGH_RISK_LANGUAGES.some((hl) => value.includes(hl)),
  isTarget: (value, context) => value.includes(context.targetLang.split(".")[0] ?? ""),
});
