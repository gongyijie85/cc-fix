// CC-Fix CLI 入口

import { Command } from "commander";
import chalk from "chalk";
import { runDetection } from "./detection/runner.js";
import { getTargetRegion, DEFAULT_REGION } from "./detection/regions.js";
import { fetchIpIntelligence } from "./proxy/ip-intel.js";
import { renderCheckResponse, renderJsonResponse } from "./output/terminal.js";
import { recordCheck } from "./fix/history.js";
import { runWithInjectedEnv, runDesktop } from "./run/injector.js";
import { startGuiServer } from "./gui/server.js";
import { spawn } from "node:child_process";
import { version } from "./version.js";
import { createPersistRuntime } from "./persist/runtime.js";
import { installerPreflightExitCode } from "./persist/preflight.js";
import { parseRegionCode, resolveRegion } from "./domain/region.js";
import { resolveProtectionRequest } from "./domain/protection.js";


const program = new Command();

program
  .name("cc-fix")
  .description("Claude Code 环境安全检测与修复 CLI 工具")
  .version(version);

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
    recordCheck(response.score);

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
  .description("开启用户级持久化（默认标准保护）")
  .option("--region <region>", "目标地区；省略时沿用已提交/偏好地区")
  .option("--level <level>", "保护强度: standard | deep")
  .option("--deep", "深度保护（等价于 --level deep）")
  .action(async (options) => {
    if (options.region !== undefined) parseRegionCode(options.region, "explicit");
    const runtime = await createPersistRuntime();
    const status = await runtime.status();
    const region = resolveRegion({
      explicit: options.region,
      active: status.target?.region,
      preferred: status.preferredRegion,
    });
    const target = resolveProtectionRequest({
      currentMode: status.mode,
      resolvedRegion: region,
      level: options.level,
      deep: options.deep,
    });
    const result = await runtime.protect(target);
    if (result.kind === "recovery_required") {
      throw new Error("保护转换补偿不完整；请运行 `cc-fix persist recover`");
    }
    if (result.kind === "compensated") {
      throw new Error("保护转换失败，已完整回滚；系统仍保持原模式");
    }
    const suffix = result.kind === "degraded" ? `（降级：${result.degraded.length} 个浏览器策略槽未对齐）` : "";
    console.log(chalk.green(`✓ 已提交 ${target.mode} / ${target.region} ${suffix}`));
    console.log(chalk.dim("运行 `cc-fix check` 验证效果；浏览器可能需要重启"));
  });

persistCmd
  .command("off")
  .description("关闭用户级持久化，恢复原始环境")
  .action(async () => {
    const result = await (await createPersistRuntime()).restore();
    if (result.kind === "recovery_required") {
      throw new Error(`还原尚未完成（${result.failed.join(", ")}）；请运行 \`cc-fix persist recover\``);
    }
    console.log(result.kind === "noop" ? chalk.dim("当前已是日常模式") : chalk.green("✓ 已完整还原日常配置"));
  });

persistCmd
  .command("recover")
  .description("继续未完成的保护补偿或日常还原")
  .action(async () => {
    const result = await (await createPersistRuntime()).recover();
    if (result.kind === "recovery_required") throw new Error(`仍有未恢复项：${result.failed.join(", ")}`);
    console.log(result.kind === "noop" ? chalk.dim("没有需要恢复的事务") : chalk.green("✓ 恢复事务已收敛"));
  });

persistCmd
  .command("status")
  .description("查看持久化状态")
  .option("--json", "JSON 格式输出")
  .action(async (options) => {
    const status = await (await createPersistRuntime()).status();
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log("\n持久化状态:");
    console.log(`  模式: ${status.mode === "daily" ? chalk.dim(status.mode) : chalk.green(status.mode)}`);
    console.log(`  健康: ${status.health === "healthy" ? chalk.green(status.health) : chalk.yellow(status.health)}`);
    console.log(`  目标地区: ${status.target?.region ?? status.preferredRegion}`);
    console.log(`  事务: ${status.transaction.kind}`);
    console.log(chalk.dim("\n切换: cc-fix persist on [--level standard|deep] [--region us] / off / recover\n"));
  });

persistCmd
  .command("preflight")
  .description("安装器内部：验证当前状态允许升级/修复")
  .option("--json", "JSON 格式输出")
  .action(async (options) => {
    const status = await (await createPersistRuntime()).status();
    const exitCode = installerPreflightExitCode(status);
    if (options.json) console.log(JSON.stringify({ allowed: exitCode === 0, status }));
    else console.log(exitCode === 0 ? chalk.green("✓ 可以安全升级或修复") : chalk.yellow("当前存在未完成恢复，禁止替换程序文件"));
    if (exitCode !== 0) process.exitCode = exitCode;
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

// gui 命令
program
  .command("gui")
  .description("启动可视化 Web 面板")
  .option("-p, --port <port>", "端口号", "3456")
  .action(async (options) => {
    const port = parseInt(options.port, 10) || 3456;
    const server = await startGuiServer(port);
    const url = server.bootstrapUrl();
    console.log(`🛡️  CC-Fix Web 面板已启动`);
    console.log(`🌐 打开浏览器访问: ${url}`);
    console.log("   按 Ctrl+C 退出");
    // 自动打开浏览器
    const opener = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true });
    opener.unref();
  });

await program.parseAsync().catch((error: unknown) => {
  console.error(chalk.red(`错误: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
});
