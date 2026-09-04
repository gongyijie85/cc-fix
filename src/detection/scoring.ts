// 评分引擎 — 根据检测信号计算风险评分

import type {
  SignalResult,
  CheckResponse,
  AccessStatus,
  IpIntelligence,
  AccessRegionCode,
} from "./types.js";

export function calculateScore(signals: SignalResult[]): number {
  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const rawScore = signals.reduce((sum, s) => sum + s.contribution, 0);
  if (totalWeight === 0) return 0;
  // 归一化到 0-100：当所有信号都命中时，rawScore == totalWeight，映射为 100
  return Math.min(100, Math.round((rawScore / totalWeight) * 100));
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

/** persist on 能直接修复的信号 id（不含 consistency：需看 value 是否含时区/Locale） */
const PERSIST_FIXABLE = new Set([
  "timezone",
  "language",
  "locale",
  "win-region",
  "utc-offset",
  "browser-policy",
]);

export function isPersistFixable(signalId: string, value?: string | null): boolean {
  if (PERSIST_FIXABLE.has(signalId)) return true;
  // 信号一致性：仅当时区/Locale 冲突时 persist 有用；纯 IP 冲突需换节点
  if (signalId === "consistency" && value) {
    return /时区|Locale/i.test(value);
  }
  return false;
}

export function generateRecommendations(signals: SignalResult[], score: number): string[] {
  const recommendations: string[] = [];

  const actionable = signals.filter(
    (s) => s.risk === "high" || s.risk === "critical" || s.risk === "medium",
  );

  for (const signal of actionable) {
    switch (signal.id) {
      case "timezone":
        recommendations.push("系统时区与目标地区不一致，运行 `cc-fix persist on` 修复");
        break;
      case "language":
        recommendations.push("系统语言设置暴露真实地区，运行 `cc-fix persist on` 修复");
        break;
      case "ip-country":
        recommendations.push(
          "出口 IP 位于高风险区域：在路由器/本机代理面板将节点切到目标地区（如 US 住宅），cc-fix 不改路由配置",
        );
        break;
      case "ip-datacenter":
        recommendations.push(
          "出口为数据中心/云厂商 IP：优先改用住宅或 ISP 节点（在代理面板操作，非本工具）",
        );
        break;
      case "ip-multi-source":
        recommendations.push(
          "多源 IP 不一致（节点抖动/分流）：代理组固定单一目标地区节点，避免自动选择在多国间跳动",
        );
        break;
      case "consistency": {
        const v = signal.value ?? "";
        const hasLocal = /时区|Locale/i.test(v);
        const hasIp = /IP\(/i.test(v);
        if (hasLocal && hasIp) {
          recommendations.push(
            "环境信号不一致（本地 + 出口）：本地先 `cc-fix persist on`；出口在代理面板切到目标地区节点",
          );
        } else if (hasLocal) {
          recommendations.push("本地时区/语言/区域不一致，运行 `cc-fix persist on` 统一信号");
        } else if (hasIp) {
          recommendations.push(
            "出口 IP 与目标地区不一致：在路由器透明代理/Clash 面板切换到目标地区节点后重跑 `cc-fix check`（本工具只提示，不改路由）",
          );
        } else {
          recommendations.push("环境信号不一致，请检查时区、语言与出口 IP");
        }
        break;
      }
      case "locale":
        recommendations.push("Intl Locale 与目标地区不一致，运行 `cc-fix persist on` 修复");
        break;
      case "base-url":
        recommendations.push("ANTHROPIC_BASE_URL 包含敏感域名，请更换代理");
        break;
      case "fonts":
        // #108：移除已停用（/api/fonts/remove → 410）；不再建议卸载系统字体
        recommendations.push("中文字体仅提示、不参与风险：移除功能已停用，请勿据此卸载系统字体；有备份可在面板「还原中文字体」恢复");
        break;
      case "dns":
        recommendations.push("DNS 解析异常（污染/假地址嫌疑），建议改用 8.8.8.8 / 1.1.1.1");
        break;
      case "proxy-env":
        // 未配置已不再计风险；若未来恢复中风险再提示
        break;
      case "win-region":
        recommendations.push("Windows 区域格式为中文，运行 `cc-fix persist on` 修复");
        break;
      case "utc-offset":
        recommendations.push("UTC 偏移与目标时区不一致，运行 `cc-fix persist on` 修复");
        break;
      case "browser-policy":
        recommendations.push("浏览器策略未就位（AcceptLanguage/WebRTC 防泄漏），运行 `cc-fix persist on` 写入");
        break;
    }
  }

  if (score > 0 && recommendations.length === 0) {
    const needsPersist = signals.some(
      (s) => s.contribution > 0 && isPersistFixable(s.id, s.value),
    );
    if (needsPersist) {
      recommendations.push("存在可修复信号，建议运行 `cc-fix persist on` 优化环境");
    } else {
      recommendations.push("剩余风险多为出口 IP 等网络因素，persist 无法自动消除");
    }
  }

  if (score === 0) {
    recommendations.push("环境信号正常，继续保持");
  }

  // 去重保序
  return [...new Set(recommendations)];
}

export function buildCheckResponse(
  signals: SignalResult[],
  ipIntel: IpIntelligence | null,
  region: AccessRegionCode
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
