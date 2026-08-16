// 终端输出 — 对标 checkcc.org 风格

import chalk from "chalk";
import Table from "cli-table3";
import type { CheckResponse, SignalResult, IpIntelligence } from "../detection/types.js";
import { isPersistFixable } from "../detection/scoring.js";

function getRiskColor(risk: SignalResult["risk"]): (text: string) => string {
  switch (risk) {
    case "critical": return chalk.red;
    case "high": return chalk.red;
    case "medium": return chalk.yellow;
    case "low": return chalk.green;
  }
}

function getRiskEmoji(risk: SignalResult["risk"]): string {
  switch (risk) {
    case "critical": return "❌";
    case "high": return "❌";
    case "medium": return "⚠️";
    case "low": return "✅";
  }
}

function getScoreColor(score: number): (text: string) => string {
  if (score >= 71) return chalk.red;
  if (score >= 51) return chalk.red;
  if (score >= 21) return chalk.yellow;
  return chalk.green;
}

function getScoreEmoji(score: number): string {
  if (score >= 71) return "🔴";
  if (score >= 51) return "🟠";
  if (score >= 21) return "🟡";
  return "🟢";
}

function getRiskLabel(risk: SignalResult["risk"]): string {
  switch (risk) {
    case "critical": return "极高风险";
    case "high": return "高风险";
    case "medium": return "中风险";
    case "low": return "安全";
  }
}

function renderIpIntel(ip: IpIntelligence): void {
  console.log(chalk.bold("🌐 网络出口信息:"));
  console.log(`  IP: ${ip.ip || "N/A"}`);
  console.log(`  位置: ${[ip.country, ip.region, ip.city].filter(Boolean).join(" / ") || "N/A"}`);
  console.log(`  组织: ${ip.org || "N/A"} (${ip.asn || "N/A"})`);
  console.log(`  时区: ${ip.timezone || "N/A"}`);

  // Phase 2 新增字段
  const ipTypeLabel = ip.ipType === "datacenter"
    ? chalk.red("数据中心 IP ⚠️")
    : ip.ipType === "residential"
      ? chalk.green("住宅/普通 ISP")
      : chalk.dim("未知");
  console.log(`  IP 类型: ${ipTypeLabel}`);

  const consistencyLabel = ip.multiSourceConsistent
    ? chalk.green(`一致 (${ip.sourceCount} 源)`)
    : chalk.red(`不一致 (${ip.sourceCount} 源) ⚠️`);
  console.log(`  多源一致性: ${consistencyLabel}`);
  console.log();
}

export function renderCheckResponse(response: CheckResponse): void {
  const { score, riskLevel, signals, recommendations, ipIntelligence } = response;

  console.log();
  console.log(chalk.bold.cyan("╔══════════════════════════════════════════════════════╗"));
  console.log(chalk.bold.cyan("║") + chalk.bold("  🛡️  CC-Fix 环境风险检测报告") + "                    " + chalk.bold.cyan("║"));
  console.log(chalk.bold.cyan("╠══════════════════════════════════════════════════════╣"));

  const scoreColor = getScoreColor(score);
  const scoreEmoji = getScoreEmoji(score);
  const riskLabel = riskLevel === "critical" ? "极高风险" : riskLevel === "high" ? "高风险" : riskLevel === "medium" ? "中风险" : "低风险";

  console.log(chalk.bold.cyan("║") + `  ${scoreEmoji} 风险评分: ${scoreColor(`${score}/100`)}  ${riskLabel}`.padEnd(56) + chalk.bold.cyan("║"));

  // 统计高危风险数
  const highRiskCount = signals.filter((s) => s.risk === "high" || s.risk === "critical").length;
  if (highRiskCount > 0) {
    console.log(chalk.bold.cyan("║") + chalk.red(`  ⚠️  命中高危风险 ${highRiskCount} 个`) + "                                        ".slice(0, 56 - 14 - String(highRiskCount).length) + chalk.bold.cyan("║"));
  }

  // 检测维度统计
  console.log(chalk.bold.cyan("║") + `  📊 检测维度: ${signals.length} 个信号` + "                                  ".slice(0, Math.max(0, 56 - 14 - String(signals.length).length)) + chalk.bold.cyan("║"));

  console.log(chalk.bold.cyan("╚══════════════════════════════════════════════════════╝"));
  console.log();

  // IP 信息摘要
  if (ipIntelligence) {
    renderIpIntel(ipIntelligence);
  }

  // 信号详情表格
  console.log(chalk.bold("📊 检测信号详情:"));
  console.log();

  const table = new Table({
    head: ["检测项", "当前值", "风险", "风险分值"],
    colWidths: [18, 28, 8, 12],
    style: { head: ["cyan"] },
  });

  // 按贡献值排序（高风险在前）
  const sorted = [...signals].sort((a, b) => b.contribution - a.contribution);

  for (const signal of sorted) {
    const riskColor = getRiskColor(signal.risk);
    const riskEmoji = getRiskEmoji(signal.risk);
    const contribStr = signal.contribution > 0 ? chalk.red(`+${signal.contribution}`) : chalk.green("+0");

    table.push([
      signal.label,
      signal.value || "N/A",
      riskColor(riskEmoji + " " + getRiskLabel(signal.risk)),
      contribStr,
    ]);
  }

  console.log(table.toString());
  console.log();

  // 建议
  if (recommendations.length > 0) {
    console.log(chalk.bold("💡 修复建议:"));
    for (const rec of recommendations) {
      console.log(`  • ${rec}`);
    }
    console.log();
  }

  // 快速操作提示（仅当仍有 persist 可修项时推 on）
  console.log(chalk.dim("─────────────────────────────────────────────────"));
  const needsPersist = signals.some(
    (s) => s.contribution > 0 && isPersistFixable(s.id, s.value),
  );
  if (needsPersist) {
    console.log(chalk.bold("  🔧 快速修复: ") + chalk.yellow("cc-fix persist on"));
    console.log(chalk.dim("  一键统一时区/语言/区域/浏览器策略"));
  } else if (score > 0) {
    console.log(chalk.bold("  ℹ️  本机 persist 已到位；剩余靠网络侧"));
    console.log(chalk.dim("  出口 IP → 在路由器/代理面板换目标地区节点；中文字体 → 手动卸载"));
    console.log(chalk.dim("  cc-fix 只检测与提示，不会改路由器或 VPN 配置"));
  } else {
    console.log(chalk.green("  ✅ 环境信号正常，继续保持"));
  }
  console.log(chalk.dim("─────────────────────────────────────────────────"));
  console.log();
}

export function renderJsonResponse(response: CheckResponse & { schemaVersion?: number }): void {
  console.log(JSON.stringify(response, null, 2));
}
