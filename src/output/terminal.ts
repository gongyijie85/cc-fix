// 终端输出 — 彩色表格和 JSON 格式

import chalk from "chalk";
import Table from "cli-table3";
import type { CheckResponse, SignalResult } from "../detection/types.js";

function getRiskColor(risk: SignalResult["risk"]): (text: string) => string {
  switch (risk) {
    case "critical":
      return chalk.red;
    case "high":
      return chalk.red;
    case "medium":
      return chalk.yellow;
    case "low":
      return chalk.green;
  }
}

function getRiskEmoji(risk: SignalResult["risk"]): string {
  switch (risk) {
    case "critical":
      return "❌";
    case "high":
      return "❌";
    case "medium":
      return "⚠️";
    case "low":
      return "✅";
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

export function renderCheckResponse(response: CheckResponse): void {
  const { score, riskLevel, signals, recommendations } = response;

  console.log();
  console.log(chalk.bold("╔══════════════════════════════════════════════════╗"));
  console.log(chalk.bold("║")) + "  " + chalk.bold("CC-Fix 环境检测报告") + "                    " + chalk.bold("║");
  console.log(chalk.bold("╠══════════════════════════════════════════════════╣"));

  const scoreColor = getScoreColor(score);
  const scoreEmoji = getScoreEmoji(score);
  const riskLabel = riskLevel === "critical" ? "极高风险" : riskLevel === "high" ? "高风险" : riskLevel === "medium" ? "中风险" : "低风险";

  console.log(chalk.bold("║") + `  风险评分: ${scoreColor(`${score}/100`)} (${scoreEmoji} ${riskLabel})`.padEnd(48) + chalk.bold("║"));
  console.log(chalk.bold("╠══════════════════════════════════════════════════╣"));
  console.log();

  const table = new Table({
    head: ["信号", "当前值", "状态", "权重"],
    colWidths: [20, 25, 10, 8],
    style: { head: ["cyan"] },
  });

  for (const signal of signals) {
    const riskColor = getRiskColor(signal.risk);
    const riskEmoji = getRiskEmoji(signal.risk);

    table.push([
      signal.label,
      signal.value || "N/A",
      riskColor(riskEmoji + " " + signal.risk),
      String(signal.weight),
    ]);
  }

  console.log(table.toString());
  console.log();

  if (recommendations.length > 0) {
    console.log(chalk.bold("建议:"));
    for (const rec of recommendations) {
      console.log(`  • ${rec}`);
    }
    console.log();
  }
}

export function renderJsonResponse(response: CheckResponse): void {
  console.log(JSON.stringify(response, null, 2));
}
