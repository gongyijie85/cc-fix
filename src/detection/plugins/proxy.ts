// 代理环境检测插件 — 检查 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 是否配置

import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

export const proxyPlugin: DetectionPlugin = {
  id: "proxy-env",
  label: "代理环境",
  weight: 6,
  run: async (_context: DetectionContext): Promise<SignalResult> => {
    const setKeys: string[] = [];
    for (const key of PROXY_ENV_KEYS) {
      if (process.env[key]) {
        setKeys.push(key);
      }
    }

    const hasProxy = setKeys.length > 0;

    return {
      id: "proxy-env",
      label: "代理环境",
      value: hasProxy
        ? `已配置 (${setKeys.join(", ")})`
        : "未配置代理环境变量",
      score: hasProxy ? 0 : 1,
      weight: 6,
      contribution: hasProxy ? 0 : 6,
      source: "system",
      risk: hasProxy ? "low" : "medium",
    };
  },
};
