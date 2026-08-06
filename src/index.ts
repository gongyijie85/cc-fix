// CC-Fix CLI 入口

import { Command } from "commander";
import chalk from "chalk";
import { runDetection } from "./detection/runner.js";
import { getTargetRegion, DEFAULT_REGION } from "./detection/regions.js";
import { fetchIpIntelligence } from "./proxy/ip-intel.js";
import { renderCheckResponse, renderJsonResponse } from "./output/terminal.js";
import { createBackup, restoreBackup, getPersistStatus, setEnvVar, loadBackup } from "./platform/windows.js";
import { runWithInjectedEnv, runDesktop } from "./run/injector.js";


const program = new Command();

program
  .name("cc-fix")
  .description("Claude Code 环境安全检测与修复 CLI 工具")
  .version("0.1.0");

// check 命令
program
  .command("check")
  .description("检测环境风险")
  .option("--json", "JSON 格式输出")
  .option("--region <region>", "目标地区", DEFAULT_REGION)
  .action(async (options) => {
    const target = getTargetRegion(options.region);
    const ipIntel = await fetchIpIntelligence();
    const response = await runDetection("auto", target.timezone, target.lang, ipIntel);

    if (options.json) {
      renderJsonResponse(response);
    } else {
      renderCheckResponse(response);
    }
  });

// persist 命令
const persistCmd = program
  .command("persist")
  .description("用户级持久化管理");

persistCmd
  .command("on")
  .description("开启用户级持久化")
  .option("--region <region>", "目标地区", DEFAULT_REGION)
  .action((options) => {
    const target = getTargetRegion(options.region);
    const envKeys = ["TZ", "LANG", "LC_ALL"];

    const hadBackup = loadBackup() !== null;
    createBackup(envKeys);

    if (hadBackup) {
      console.log("📋 已有原始备份（不会覆盖），直接更新环境变量...");
    } else {
      console.log("📋 已备份当前原始设置...");
    }

    console.log("正在设置环境变量...");
    setEnvVar("TZ", target.timezone);
    setEnvVar("LANG", target.lang);
    setEnvVar("LC_ALL", target.lcAll);

    console.log(`✅ 持久化已开启，目标地区: ${target.name}`);
    console.log("   新终端将自动使用安全环境，日常办公不受影响");
    console.log(chalk.dim("   提示: 原始值已安全保存，persist off 时会完整恢复"));
  });

persistCmd
  .command("off")
  .description("关闭用户级持久化，恢复原始环境")
  .action(() => {
    const status = getPersistStatus();

    if (!status.enabled || !status.backup) {
      console.log("持久化未开启");
      return;
    }

    console.log("正在恢复原始设置...");
    restoreBackup(status.backup);
    console.log("✅ 持久化已关闭，环境变量已恢复");
  });

persistCmd
  .command("status")
  .description("查看持久化状态")
  .action(() => {
    const status = getPersistStatus();

    console.log("\n持久化状态:");
    console.log(`  已开启: ${status.enabled ? "是" : "否"}`);

    if (status.backup) {
      console.log(`  备份时间: ${status.backup.timestamp}`);
    }

    console.log("\n当前环境变量（用户级）:");
    for (const [key, value] of Object.entries(status.current)) {
      console.log(`  ${key}: ${value || "(未设置)"}`);
    }
    console.log();
  });

// run 命令
program
  .command("run [command...]")
  .description("以安全环境启动命令")
  .option("--desktop", "包装启动 Claude Desktop")
  .option("--region <region>", "目标地区", DEFAULT_REGION)
  .action(async (commandArgs, options) => {
    const target = getTargetRegion(options.region);

    if (options.desktop) {
      const code = await runDesktop(target);
      process.exit(code);
    }

    if (!commandArgs || commandArgs.length === 0) {
      console.error("请指定要运行的命令，例如: cc-fix run claude");
      process.exit(1);
    }

    const [command, ...args] = commandArgs;
    const code = await runWithInjectedEnv(command, args, target);
    process.exit(code);
  });

// proxy check 命令
program
  .command("proxy")
  .command("check")
  .description("检测出口 IP / 代理状态")
  .action(async () => {
    console.log("正在检测出口 IP...");
    const ipIntel = await fetchIpIntelligence();

    if (!ipIntel) {
      console.error("❌ 无法获取 IP 信息，请检查网络连接");
      process.exit(1);
    }

    console.log("\n出口 IP 信息:");
    console.log(`  IP: ${ipIntel.ip || "N/A"}`);
    console.log(`  国家: ${ipIntel.country || "N/A"}`);
    console.log(`  地区: ${ipIntel.region || "N/A"}`);
    console.log(`  城市: ${ipIntel.city || "N/A"}`);
    console.log(`  ASN: ${ipIntel.asn || "N/A"}`);
    console.log(`  组织: ${ipIntel.org || "N/A"}`);
    console.log(`  时区: ${ipIntel.timezone || "N/A"}`);

    const highRiskCountries = ["CN", "RU", "IR"];
    if (ipIntel.country && highRiskCountries.includes(ipIntel.country.toUpperCase())) {
      console.log("\n❌ 出口 IP 位于高风险区域，请更换代理节点");
    } else {
      console.log("\n✅ 出口 IP 地区正常");
    }
    console.log();
  });

program.parse();
