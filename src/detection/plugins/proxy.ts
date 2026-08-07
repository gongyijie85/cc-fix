// 代理环境检测插件 — 检查 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 是否配置
//
// 语义：展示配置状态（SPEC），但「未配置」本身不是风险。
// 多数场景出口已在海外时不需要代理；只有用户在高风险地区且无代理时才提示。

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

    // 未配置：低风险、零贡献（状态可见即可，避免把「正常直连」判成中风险）
    // 已配置：低风险
    return {
      id: "proxy-env",
      label: "代理环境",
      value: hasProxy
        ? `已配置 (${setKeys.join(", ")})`
        : "未配置代理环境变量",
      score: 0,
      weight: 6,
      contribution: 0,
      source: "system",
      risk: "low",
    };
  },
};
