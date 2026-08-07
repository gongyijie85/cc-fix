// CC-Fix CLI 入口

import { Command } from "commander";
import chalk from "chalk";
import { runDetection } from "./detection/runner.js";
import { getTargetRegion, DEFAULT_REGION } from "./detection/regions.js";
import { fetchIpIntelligence } from "./proxy/ip-intel.js";
import { renderCheckResponse, renderJsonResponse } from "./output/terminal.js";
import { getPersistStatus } from "./platform/windows.js";
import { persistOnFlow, persistOffFlow } from "./fix/flow.js";
import { runWithInjectedEnv, runDesktop } from "./run/injector.js";
import { startGuiServer } from "./gui/server.js";
import { exec } from "node:child_process";
import type { StreamEvent } from "./events/types.js";


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
  .action(async (options) => {
    const target = getTargetRegion(options.region);
    await persistOnFlow(
      { regionCode: options.region, targetTimezone: target.timezone, targetLang: target.lang, targetLcAll: target.lcAll },
      (event: StreamEvent) => {
        if (event.type === "step-start") {
          const change = event.oldValue !== undefined ? `: ${event.oldValue} → ${event.newValue}` : "";
          console.log(chalk.dim(`▶ ${event.name}${change}`));
        }
        if (event.type === "step-ok") {
          console.log(chalk.green(`  ✓ 完成${event.rollback ? " (回滚)" : ""}`));
        }
        if (event.type === "step-fail") {
          console.log(chalk.red(`  ✗ 失败${event.rollback ? " (回滚)" : ""}: ${event.error}`));
        }
        if (event.type === "summary") {
          if (event.fatal) {
            console.log(chalk.red.bold("══ 致命错误，需手动检查 HKCU\\Environment ══"));
          } else {
            const parts = [`${event.ok} 成功`];
            if (event.fail > 0) parts.push(`${event.fail} 失败`);
            if (event.rolledBack) parts.push("已回滚");
            console.log(chalk.dim(`══ ${parts.join(" · ")} ══`));
          }
          console.log(chalk.dim("运行 `cc-fix check` 验证效果"));
        }
      },
    );
  });

persistCmd
  .command("off")
  .description("关闭用户级持久化，恢复原始环境")
  .action(async () => {
    await persistOffFlow((event: StreamEvent) => {
      if (event.type === "step-start") {
        const change = event.oldValue !== undefined ? `: ${event.oldValue} → ${event.newValue}` : "";
        console.log(chalk.dim(`▶ ${event.name}${change}`));
      }
      if (event.type === "step-ok") {
        console.log(chalk.green(`  ✓ 完成`));
      }
      if (event.type === "step-fail") {
        console.log(chalk.red(`  ✗ 失败: ${event.error}`));
      }
      if (event.type === "summary") {
        if (event.fatal) {
          console.log(chalk.red.bold("══ 致命错误，需手动检查 HKCU\\Environment ══"));
        } else {
          console.log(chalk.dim(`══ ${event.ok} 成功 ══`));
        }
        console.log(chalk.dim("运行 `cc-fix check` 验证效果"));
      }
    });
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

// gui 命令
program
  .command("gui")
  .description("启动可视化 Web 面板")
  .option("-p, --port <port>", "端口号", "3456")
  .action(async (options) => {
    const port = parseInt(options.port, 10) || 3456;
    await startGuiServer(port);
    const url = `http://127.0.0.1:${port}`;
    console.log(`🛡️  CC-Fix Web 面板已启动`);
    console.log(`🌐 打开浏览器访问: ${url}`);
    console.log("   按 Ctrl+C 退出");
    // 自动打开浏览器
    exec(`start ${url}`);
  });

program.parse();
