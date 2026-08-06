// 进程级注入 — 以安全环境启动命令

import { spawn } from "node:child_process";
import type { TargetRegion } from "../detection/types.js";

export function buildEnvVars(target: TargetRegion): Record<string, string> {
  return {
    TZ: target.timezone,
    LANG: target.lang,
    LC_ALL: target.lcAll,
  };
}

export function runWithInjectedEnv(
  command: string,
  args: string[],
  target: TargetRegion
): Promise<number> {
  const envVars = buildEnvVars(target);

  const child = spawn(command, args, {
    env: { ...process.env, ...envVars },
    stdio: "inherit",
    shell: true,
  });

  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve(code ?? 0);
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
    if (require("node:fs").existsSync(desktopPath)) {
      return runWithInjectedEnv(desktopPath, [], target);
    }
  }

  console.error("未找到 Claude Desktop 安装路径");
  return Promise.resolve(1);
}
