import { describe, it, expect } from "vitest";
import { buildEnvVars, runWithInjectedEnv } from "./injector.js";
import type { TargetRegion } from "../detection/types.js";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const usTarget: TargetRegion = {
  code: "us",
  name: "United States",
  timezone: "America/New_York",
  lang: "en_US.UTF-8",
  lcAll: "en_US.UTF-8",
};

describe("buildEnvVars", () => {
  it("builds correct env vars for US target", () => {
    const target: TargetRegion = {
      code: "us",
      name: "United States",
      timezone: "America/New_York",
      lang: "en_US.UTF-8",
      lcAll: "en_US.UTF-8",
    };

    const envVars = buildEnvVars(target);
    expect(envVars.TZ).toBe("America/New_York");
    expect(envVars.LANG).toBe("en_US.UTF-8");
    expect(envVars.LC_ALL).toBe("en_US.UTF-8");
  });

  it("builds correct env vars for JP target", () => {
    const target: TargetRegion = {
      code: "jp",
      name: "Japan",
      timezone: "Asia/Tokyo",
      lang: "ja_JP.UTF-8",
      lcAll: "ja_JP.UTF-8",
    };

    const envVars = buildEnvVars(target);
    expect(envVars.TZ).toBe("Asia/Tokyo");
    expect(envVars.LANG).toBe("ja_JP.UTF-8");
  });
});

describe("runWithInjectedEnv spawn contract (issue #52)", () => {
  // 参数元字符原样传递：& | 由 shell 解释时会破坏参数（旧实现 shell:true 的注入面）。
  it("passes shell metacharacters in args through verbatim", async () => {
    const probe = "process.exit(process.argv[1] === 'a&b' && process.argv[2] === 'x|y' ? 0 : 7)";
    const code = await runWithInjectedEnv(process.execPath, ["-e", probe, "a&b", "x|y"], usTarget);
    expect(code).toBe(0);
  });

  // 含空格的命令路径：旧实现 shell:true 下 cmd.exe 把 "C:\Program" 当命令导致启动失败。
  it("launches a command whose path contains spaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-fix-inj-"));
    try {
      const spacedDir = join(root, "dir with spaces");
      // Windows 用 junction（无需管理员权限），POSIX 用目录符号链接。
      await symlink(dirname(process.execPath), spacedDir, process.platform === "win32" ? "junction" : "dir");
      const spacedNode = join(spacedDir, basename(process.execPath));
      const code = await runWithInjectedEnv(spacedNode, ["-e", "process.exit(0)"], usTarget);
      expect(code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // spawn 失败必须 reject（交由顶级 catch 归类退出码 30）：旧实现未监听 error 事件，进程直接崩溃。
  it("rejects instead of crashing when the command cannot spawn", async () => {
    await expect(
      runWithInjectedEnv("cc-fix-definitely-missing-command-xyz", [], usTarget),
    ).rejects.toThrow();
  });

  // 信号终止（code=null）不得当成功 0：按 shell 惯例映射 128+n（SIGTERM=143）。
  // Windows 上 Node 以退出码 1 模拟信号终止，无法产生 code=null，仅 POSIX 断言。
  describe.skipIf(process.platform === "win32")("signal termination", () => {
    it("maps SIGTERM termination to 128+15", async () => {
      const code = await runWithInjectedEnv(
        process.execPath,
        ["-e", "process.kill(process.pid, 'SIGTERM')"],
        usTarget,
      );
      expect(code).toBe(143);
    });
  });
});
