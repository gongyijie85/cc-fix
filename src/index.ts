// CC-Fix CLI 入口

import { Command, CommanderError } from "commander";
import chalk from "chalk";
import { runDetection } from "./detection/runner.js";
import { getTargetRegion, DEFAULT_REGION } from "./detection/regions.js";
import { fetchIpIntelligence } from "./proxy/ip-intel.js";
import { renderCheckResponse, renderJsonResponse } from "./output/terminal.js";
import { recordCheck, recordPersistFacts } from "./fix/history.js";
import { runWithInjectedEnv, runDesktop } from "./run/injector.js";
import { startGuiServer } from "./gui/server.js";
import { spawn } from "node:child_process";
import { version } from "./version.js";
import { createPersistRuntime } from "./persist/runtime.js";
import { installerPreflightExitCode } from "./persist/preflight.js";
import { parseRegionCode, resolveRegion } from "./domain/region.js";
import { resolveProtectionRequest } from "./domain/protection.js";
import {
  CLI_SCHEMA_VERSION,
  EXIT_DEGRADED,
  EXIT_INVALID_INPUT,
  CliFailure,
  classifyError,
  errorIdForOutcome,
  exitCodeForProtectOutcome,
  exitCodeForRecoveryOutcome,
  exitCodeForRestoreOutcome,
} from "./cli/exit-codes.js";

const program = new Command();

program
  .name("cc-fix")
  .description("Claude Code 环境安全检测与修复 CLI 工具")
  .version(version)
  .showHelpAfterError();

// commander 自身参数错误统一映射为非法输入（10），不让其默认退出码泄漏到契约外；
// help/version 是 commander 以 exitCode 0 触发的正常显示路径，保持成功退出。
program.exitOverride((error: CommanderError) => {
  if (error.exitCode === 0) throw new CliFailure(0, "INTERNAL", "");
  throw new CliFailure(EXIT_INVALID_INPUT, "INVALID_COMMAND", error.message);
});

/** 当前命令是否请求了 JSON 输出；顶级 catch 据此选择错误呈现。 */
let jsonOutput = false;

function jsonEnvelope(payload: Record<string, unknown>) {
  return JSON.stringify({ schemaVersion: CLI_SCHEMA_VERSION, ok: true, ...payload }, null, 2);
}

// check 命令
program
  .command("check")
  .description("检测环境风险")
  .option("--json", "JSON 格式输出")
  .option("--region <region>", "目标地区", DEFAULT_REGION)
  .action(async (options) => {
    jsonOutput = options.json === true;
    const target = getTargetRegion(options.region);
    const ipIntel = await fetchIpIntelligence();
    const response = await runDetection("auto", target.timezone, target.lang, ipIntel);
    await recordCheck(response.score);

    if (options.json) {
      renderJsonResponse({ schemaVersion: CLI_SCHEMA_VERSION, ...response });
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
  .option("--json", "JSON 格式输出")
  .option("--region <region>", "目标地区；省略时沿用已提交/偏好地区")
  .option("--level <level>", "保护强度: standard | deep")
  .option("--deep", "深度保护（等价于 --level deep）")
  .action(async (options) => {
    jsonOutput = options.json === true;
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

    const after = await runtime.status();
    const facts = {
      requested: target,
      committed: after.target,
      preferredRegion: after.preferredRegion,
      activeRegion: after.target?.region ?? after.preferredRegion,
      health: after.health,
      transaction: after.transaction,
      noOp: result.kind === "noop",
      rolledBack: result.kind === "compensated",
      ...(result.kind === "degraded" ? { degraded: result.degraded } : {}),
    };

    void recordPersistFacts({
      action: "persist-on",
      outcome: result.kind === "noop" ? "noop" : result.kind === "committable" ? "ok" : result.kind,
      requested: target,
      committed: after.target,
      resolvedRegion: region,
      preferredRegion: after.preferredRegion,
      health: after.health,
      counts: result.kind === "noop" ? undefined : result.kind === "compensated" || result.kind === "recovery_required" ? { ok: 0, fail: 1 } : { ok: 1, fail: 0 },
      rolledBack: result.kind === "compensated",
      noOp: result.kind === "noop",
    });

    if (result.kind === "recovery_required") {
      throw new CliFailure(
        exitCodeForProtectOutcome(result.kind),
        errorIdForOutcome(result.kind),
        "保护转换补偿不完整；请运行 `cc-fix persist recover`",
      );
    }
    if (result.kind === "compensated") {
      throw new CliFailure(
        exitCodeForProtectOutcome(result.kind),
        errorIdForOutcome(result.kind),
        "保护转换失败，已完整回滚；系统仍保持原模式",
      );
    }
    // degraded 非错误：事务已提交，仅健康降级（契约退出码 2）；不 throw，正常输出后以退出码示意。
    if (result.kind === "degraded") {
      process.exitCode = EXIT_DEGRADED;
    }

    if (options.json) {
      console.log(jsonEnvelope(facts));
      return;
    }
    if (result.kind === "degraded") {
      console.log(chalk.yellow(`✓ 已提交 ${target.mode} / ${target.region}（降级：${result.degraded.length} 个浏览器策略槽未对齐）`));
    } else {
      console.log(chalk.green(`✓ 已提交 ${target.mode} / ${target.region}`));
    }
    console.log(chalk.dim("运行 `cc-fix check` 验证效果；浏览器可能需要重启"));
  });

persistCmd
  .command("off")
  .description("关闭用户级持久化，恢复原始环境")
  .option("--json", "JSON 格式输出")
  .action(async (options) => {
    jsonOutput = options.json === true;
    const runtime = await createPersistRuntime();
    const result = await runtime.restore();
    if (result.kind === "recovery_required") {
      void recordPersistFacts({
        action: "persist-off",
        outcome: "recovery_required",
        requested: null,
        committed: null,
        counts: { ok: 0, fail: result.failed.length },
      });
      throw new CliFailure(
        exitCodeForRestoreOutcome(result.kind),
        errorIdForOutcome(result.kind),
        `还原尚未完成（${result.failed.join(", ")}）；请运行 \`cc-fix persist recover\``,
      );
    }
    const after = await runtime.status();
    void recordPersistFacts({
      action: "persist-off",
      outcome: result.kind === "noop" ? "noop" : "ok",
      requested: null,
      committed: after.target,
      preferredRegion: after.preferredRegion,
      health: after.health,
      counts: { ok: 1, fail: 0 },
      noOp: result.kind === "noop",
    });
    if (options.json) {
      console.log(jsonEnvelope({
        requested: null,
        committed: after.target,
        preferredRegion: after.preferredRegion,
        activeRegion: after.target?.region ?? after.preferredRegion,
        health: after.health,
        transaction: after.transaction,
        noOp: result.kind === "noop",
        rolledBack: false,
      }));
      return;
    }
    console.log(result.kind === "noop" ? chalk.dim("当前已是日常模式") : chalk.green("✓ 已完整还原日常配置"));
  });

persistCmd
  .command("recover")
  .description("继续未完成的保护补偿或日常还原")
  .option("--json", "JSON 格式输出")
  .action(async (options) => {
    jsonOutput = options.json === true;
    const runtime = await createPersistRuntime();
    const result = await runtime.recover();
    if (result.kind === "recovery_required") {
      void recordPersistFacts({
        action: "persist-recover",
        outcome: "recovery_required",
        requested: null,
        committed: null,
        counts: { ok: 0, fail: result.failed.length },
      });
      throw new CliFailure(
        exitCodeForRecoveryOutcome(result.kind),
        errorIdForOutcome(result.kind),
        `仍有未恢复项：${result.failed.join(", ")}`,
      );
    }
    const after = await runtime.status();
    void recordPersistFacts({
      action: "persist-recover",
      outcome: result.kind === "noop" ? "noop" : "ok",
      requested: null,
      committed: after.target,
      preferredRegion: after.preferredRegion,
      health: after.health,
      counts: { ok: 1, fail: 0 },
      noOp: result.kind === "noop",
    });
    if (options.json) {
      console.log(jsonEnvelope({
        requested: null,
        committed: after.target,
        preferredRegion: after.preferredRegion,
        activeRegion: after.target?.region ?? after.preferredRegion,
        health: after.health,
        transaction: after.transaction,
        noOp: result.kind === "noop",
        rolledBack: false,
      }));
      return;
    }
    console.log(result.kind === "noop" ? chalk.dim("没有需要恢复的事务") : chalk.green("✓ 恢复事务已收敛"));
  });

persistCmd
  .command("status")
  .description("查看持久化状态")
  .option("--json", "JSON 格式输出")
  .action(async (options) => {
    jsonOutput = options.json === true;
    const status = await (await createPersistRuntime()).status();
    if (options.json) {
      console.log(jsonEnvelope({ status }));
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
    jsonOutput = options.json === true;
    const status = await (await createPersistRuntime()).status();
    const exitCode = installerPreflightExitCode(status);
    if (options.json) console.log(jsonEnvelope({ allowed: exitCode === 0, status, preflightExitCode: exitCode }));
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
    jsonOutput = options.json === true;
    const target = getTargetRegion(options.region);

    if (options.desktop) {
      const code = await runDesktop(target);
      process.exit(code);
    }

    if (!commandArgs || commandArgs.length === 0) {
      throw new CliFailure(EXIT_INVALID_INPUT, "INVALID_COMMAND", "请指定要运行的命令，例如: cc-fix run claude");
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
  .option("--json", "JSON 格式输出")
  .action(async (options) => {
    jsonOutput = options.json === true;
    const ipIntel = await fetchIpIntelligence();

    if (!ipIntel) {
      throw new Error("无法获取 IP 信息，请检查网络连接");
    }

    if (options.json) {
      console.log(jsonEnvelope({ ipIntel }));
      return;
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
    jsonOutput = false;
    const port = parseInt(options.port, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new CliFailure(EXIT_INVALID_INPUT, "INVALID_COMMAND", `非法端口号: ${options.port}`);
    }
    const server = await startGuiServer(port);
    const url = server.bootstrapUrl();
    console.log("🛡️  CC-Fix Web 面板已启动");
    console.log(`🌐 打开浏览器访问: ${url}`);
    console.log("   按 Ctrl+C 退出");
    // 自动打开浏览器
    const opener = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true });
    opener.unref();
  });

try {
  await program.parseAsync(process.argv);
} catch (error: unknown) {
  const { exitCode, errorId } = classifyError(error);
  const message = error instanceof Error ? error.message : String(error);
  if (jsonOutput) {
    console.log(JSON.stringify({
      schemaVersion: CLI_SCHEMA_VERSION,
      ok: false,
      error: { id: errorId, code: exitCode, message },
    }, null, 2));
  } else if (exitCode !== 0 && message.length > 0) {
    console.error(chalk.red(`错误 [${errorId}]: ${message}`));
  }
  process.exitCode = exitCode;
}
