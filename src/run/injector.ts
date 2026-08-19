// 进程级注入 — 以安全环境启动命令

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { TargetRegion } from "../detection/types.js";

export function buildEnvVars(target: TargetRegion): Record<string, string> {
  return {
    TZ: target.timezone,
    LANG: target.lang,
    LC_ALL: target.lcAll,
  };
}

/** 常见信号 → 信号编号（shell 惯例：信号终止的退出码为 128+n）。 */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGTERM: 15,
};

export function runWithInjectedEnv(
  command: string,
  args: string[],
  target: TargetRegion
): Promise<number> {
  const envVars = buildEnvVars(target);

  // 不走 shell：数组参数原样传递，避免 cmd.exe/shell 解释 & | ^ % 等元字符，
  // 同时让含空格的命令路径（如 C:\Program Files\...）无需引号即可启动。
  const child = spawn(command, args, {
    env: { ...process.env, ...envVars },
    stdio: "inherit",
  });

  return new Promise((resolve, reject) => {
    // spawn 失败（ENOENT/EACCES 等）必须 reject，交由顶级 catch 归类退出码 30；
    // 不监听 error 事件会导致进程直接崩溃、退出码脱离契约。
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }
      // 信号终止（code=null）：按 shell 惯例映射 128+n，未知信号按 1 计，绝不当成功 0。
      resolve(128 + (SIGNAL_NUMBERS[signal ?? ""] ?? 1));
    });
  });
}

export function runDesktop(target: TargetRegion): Promise<number> {
  const desktopPaths = [
    `${process.env.LOCALAPPDATA}\\Programs\\claude-desktop\\Claude.exe`,
    `${process.env.LOCALAPPDATA}\\Programs\\Claude\\Claude.exe`,
    "C:\\Program Files\\Claude\\Claude.exe",
  ];

  for (const desktopPath of desktopPaths) {
    if (existsSync(desktopPath)) {
      return runWithInjectedEnv(desktopPath, [], target);
    }
  }

  console.error("未找到 Claude Desktop 安装路径");
  return Promise.resolve(1);
}
