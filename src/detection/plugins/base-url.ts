// BASE_URL 域名检测插件 — 检查 ANTHROPIC_BASE_URL 是否包含敏感域名

import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";
import { isSensitiveDomain } from "../config/sensitive-domains.js";

/**
 * 展示值脱敏（#70 决议）：只输出 hostname；URL 含 userinfo（user:password@）时掩码为 ***@host，
 * 避免凭据进入终端/GUI/报告截图。无 scheme 的输入按 https:// 前缀尝试解析，失败则原样返回。
 */
function displayBaseUrl(value: string): string {
  const candidates = value.includes("://") ? [value] : [`https://${value}`];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.hostname === "") continue;
      const hasUserInfo = url.username !== "" || url.password !== "";
      return hasUserInfo ? `***@${url.hostname}` : url.hostname;
    } catch {
      // 尝试下一个候选
    }
  }
  return value;
}

export const baseUrlPlugin: DetectionPlugin = {
  id: "base-url",
  label: "BASE_URL 域名",
  weight: 8,
  run: async (_context: DetectionContext): Promise<SignalResult> => {
    const baseUrl = process.env.ANTHROPIC_BASE_URL;

    if (!baseUrl) {
      return {
        id: "base-url",
        label: "BASE_URL 域名",
        value: "(未设置)",
        score: 0,
        weight: 8,
        contribution: 0,
        source: "system",
        risk: "low",
      };
    }

    const isSensitive = isSensitiveDomain(baseUrl);

    return {
      id: "base-url",
      label: "BASE_URL 域名",
      value: displayBaseUrl(baseUrl),
      score: isSensitive ? 1 : 0,
      weight: 8,
      contribution: isSensitive ? 8 : 0,
      source: "system",
      risk: isSensitive ? "high" : "low",
    };
  },
};
