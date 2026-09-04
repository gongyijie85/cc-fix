// #103：桌面 sidecar 认证门禁直测——通过子进程黑盒验证缺失 token/session 时
// 以退出码 2 fail-closed，不进入服务启动路径。
import { describe, expect, it, beforeAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const distSidecar = join(repoRoot, "dist", "sidecar.js");

beforeAll(() => {
  if (!existsSync(distSidecar)) {
    const command = process.platform === "win32" ? "cmd.exe" : "pnpm";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm build"] : ["build"];
    execFileSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  }
});

describe("sidecar session gate (issue #103)", () => {
  function withoutKeys(keys: string[]): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of keys) delete env[key];
    return env;
  }

  it("exits 2 without a session token", async () => {
    try {
      await execFileAsync(process.execPath, [distSidecar], {
        cwd: repoRoot,
        env: withoutKeys(["CC_FIX_GUI_TOKEN", "CC_FIX_GUI_SESSION_ID"]),
        timeout: 30_000,
      });
      expect.unreachable("sidecar without token should exit non-zero");
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      expect(failure.code).toBe(2);
      expect(failure.stderr ?? "").toContain("authenticated session");
    }
  });

  it("exits 2 without a session id", async () => {
    try {
      await execFileAsync(process.execPath, [distSidecar], {
        cwd: repoRoot,
        env: { ...withoutKeys(["CC_FIX_GUI_SESSION_ID"]), CC_FIX_GUI_TOKEN: "t-1" },
        timeout: 30_000,
      });
      expect.unreachable("sidecar without session id should exit non-zero");
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      expect(failure.code).toBe(2);
      expect(failure.stderr ?? "").toContain("authenticated session");
    }
  });
});
