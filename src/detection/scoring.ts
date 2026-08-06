// 评分引擎 — 根据检测信号计算风险评分

import type { SignalResult, CheckResponse, AccessStatus, IpIntelligence, RegionCode } from "./types.js";

export function calculateScore(signals: SignalResult[]): number {
  const total = signals.reduce((sum, signal) => sum + signal.contribution, 0);
  return Math.min(100, Math.max(0, total));
}

export function getRiskLevel(score: number): "low" | "medium" | "high" | "critical" {
  if (score >= 71) return "critical";
  if (score >= 51) return "high";
  if (score >= 21) return "medium";
  return "low";
}

export function getAccessStatus(score: number): AccessStatus {
  if (score >= 70) return "restricted";
  if (score >= 40) return "possibly_supported";
  if (score > 0) return "unknown";
  return "supported";
}

export function generateRecommendations(signals: SignalResult[], score: number): string[] {
  const recommendations: string[] = [];

  const highRiskSignals = signals.filter((s) => s.risk === "high" || s.risk === "critical");

  for (const signal of highRiskSignals) {
    switch (signal.id) {
      case "timezone":
        recommendations.push("系统时区与目标地区不一致，运行 `cc-fix persist on` 修复");
        break;
      case "language":
        recommendations.push("系统语言设置暴露真实地区，运行 `cc-fix persist on` 修复");
        break;
      case "ip-country":
        recommendations.push("出口 IP 位于高风险区域，请检查代理配置");
        break;
      case "consistency":
        recommendations.push("环境信号不一致，多个信号互相矛盾，运行 `cc-fix persist on` 统一信号");
        break;
      case "locale":
        recommendations.push("Intl Locale 与目标地区不一致");
        break;
      case "base-url":
        recommendations.push("ANTHROPIC_BASE_URL 包含敏感域名，请更换代理");
        break;
      case "fonts":
        recommendations.push("系统安装中文字体暴露真实地区，建议卸载或禁用中文字体");
        break;
      case "dns":
        recommendations.push("DNS 解析可能泄露真实地区，建议使用安全 DNS（如 8.8.8.8）");
        break;
      case "proxy-env":
        recommendations.push("未配置代理环境变量，请设置 HTTP_PROXY/HTTPS_PROXY");
        break;
      case "win-region":
        recommendations.push("Windows 区域格式为中文，运行 `cc-fix persist on` 修复");
        break;
      case "utc-offset":
        recommendations.push("UTC 偏移与目标时区不一致，运行 `cc-fix persist on` 修复");
        break;
    }
  }

  if (score > 0 && recommendations.length === 0) {
    recommendations.push("存在中等风险信号，建议运行 `cc-fix persist on` 优化环境");
  }

  if (score === 0) {
    recommendations.push("环境信号正常，继续保持");
  }

  return recommendations;
}

export function buildCheckResponse(
  signals: SignalResult[],
  ipIntel: IpIntelligence | null,
  region: RegionCode
): CheckResponse {
  const score = calculateScore(signals);
  const riskLevel = getRiskLevel(score);
  const status = getAccessStatus(score);
  const recommendations = generateRecommendations(signals, score);

  return {
    score,
    riskLevel,
    status,
    region,
    matchedRegion: null,
    signals,
    ipIntelligence: ipIntel,
    recommendations,
  };
}
