// CLI 集成测试：真实 bundle 进程（node dist/index.js）断言 stdout/stderr/退出码契约。
// persist 相关用例在隔离的临时 APPDATA 根上运行，绝不触碰真实用户状态或系统设置；
// recovery_required（21）与状态校验失败（24）通过 fixture 信封构造。
import { describe, expect, it, beforeAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCheckedEnvelope, serializeCheckedEnvelope } from "../state/checksum.js";

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const distEntry = join(repoRoot, "dist", "index.js");
const STATE_SCHEMA = "cc-fix-state-v1";

async function runCli(args: string[], appData: string) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [distEntry, ...args], {
      cwd: repoRoot,
      env: { ...process.env, APPDATA: appData },
      encoding: "utf8",
      timeout: 90_000,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function fixtureRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cc-fix-cli-int-"));
}

async function writeState(root: string, payload: unknown): Promise<void> {
  const appDataRoot = join(root, "cc-fix");
  await mkdir(appDataRoot, { recursive: true });
  await writeFile(
    join(appDataRoot, "state.json"),
    serializeCheckedEnvelope(createCheckedEnvelope(STATE_SCHEMA, payload as never)),
    "utf-8",
  );
}

const validRecoveryState = {
  schemaVersion: 1,
  revision: 1,
  committedTarget: null,
  preferredRegion: "us",
  health: "healthy",
  degradation: [],
  activeTransactionId: "t-recovery-fixture",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

beforeAll(() => {
  if (!existsSync(distEntry)) {
    // Windows 下 pnpm 是 .cmd shim，spawnSync 需经 cmd.exe 包装（与 scripts/ci/check-runtime-vulns.mjs 同因）。
    const command = process.platform === "win32" ? "cmd.exe" : "pnpm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "pnpm build"]
      : ["build"];
    execFileSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  }
});

describe("spawned CLI bundle contract (T13)", () => {
  it("--version exits 0 and prints the package version", async () => {
    const root = await fixtureRoot();
    const { exitCode, stdout } = await runCli(["--version"], root);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
    await rm(root, { recursive: true, force: true });
  });

  it("--help exits 0", async () => {
    const root = await fixtureRoot();
    const { exitCode } = await runCli(["--help"], root);
    expect(exitCode).toBe(0);
    await rm(root, { recursive: true, force: true });
  });

  it("unknown command maps to exit 10/INVALID_COMMAND", async () => {
    const root = await fixtureRoot();
    const { exitCode, stderr } = await runCli(["frobnicate"], root);
    expect(exitCode).toBe(10);
    expect(stderr).toContain("INVALID_COMMAND");
    await rm(root, { recursive: true, force: true });
  });

  it("invalid region exits 10 with JSON error id INVALID_REGION", async () => {
    const root = await fixtureRoot();
    const { exitCode, stdout } = await runCli(["check", "--region", "cn", "--json"], root);
    expect(exitCode).toBe(10);
    const parsed = JSON.parse(stdout) as { schemaVersion: number; ok: boolean; error: { id: string; code: number } };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.id).toBe("INVALID_REGION");
    expect(parsed.error.code).toBe(10);
    await rm(root, { recursive: true, force: true });
  });

  // 网络敏感用例（多源 IP 情报各带 5s 超时）：偶发慢速时手动重试一次，避免 CI/本机抖动误报。
  it("check --json exits 0 with a schema-versioned envelope (network-tolerant)", async () => {
    let attempt = 0;
    let exitCode = -1;
    let stdout = "";
    while (attempt < 2 && exitCode !== 0) {
      const root = await fixtureRoot();
      const result = await runCli(["check", "--json"], root);
      exitCode = result.exitCode;
      stdout = result.stdout;
      attempt += 1;
      await rm(root, { recursive: true, force: true });
    }
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { schemaVersion: number; score: number };
    expect(parsed.schemaVersion).toBe(1);
    expect(typeof parsed.score).toBe("number");
  });
});

describe.skipIf(process.platform !== "win32")("spawned CLI persist contract (T13)", () => {
  it("persist on with an invalid level exits 10/INVALID_PROTECTION_LEVEL without touching real state", async () => {
    const root = await fixtureRoot();
    const { exitCode, stdout } = await runCli(["persist", "on", "--level", "ultra", "--json"], root);
    expect(exitCode).toBe(10);
    const parsed = JSON.parse(stdout) as { error: { id: string } };
    expect(parsed.error.id).toBe("INVALID_PROTECTION_LEVEL");
    await rm(root, { recursive: true, force: true });
  });

  it("persist on with conflicting --deep/--level exits 10/CONFLICTING_PROTECTION_LEVEL", async () => {
    const root = await fixtureRoot();
    const { exitCode, stdout } = await runCli(["persist", "on", "--deep", "--level", "standard", "--json"], root);
    expect(exitCode).toBe(10);
    const parsed = JSON.parse(stdout) as { error: { id: string } };
    expect(parsed.error.id).toBe("CONFLICTING_PROTECTION_LEVEL");
    await rm(root, { recursive: true, force: true });
  });

  it("persist status --json on a fresh root exits 0 with daily mode", async () => {
    const root = await fixtureRoot();
    const { exitCode, stdout } = await runCli(["persist", "status", "--json"], root);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { schemaVersion: number; ok: boolean; status: { mode: string } };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.status.mode).toBe("daily");
    await rm(root, { recursive: true, force: true });
  });

  it("recovery_required state exits 21/RECOVERY_REQUIRED and refuses a new transition", async () => {
    const root = await fixtureRoot();
    await writeState(root, validRecoveryState);
    const { exitCode, stdout } = await runCli(["persist", "on", "--json"], root);
    expect(exitCode).toBe(21);
    const parsed = JSON.parse(stdout) as { error: { id: string } };
    expect(parsed.error.id).toBe("RECOVERY_REQUIRED");
    await rm(root, { recursive: true, force: true });
  });

  it("corrupt state exits 24/STATE_INVALID", async () => {
    const root = await fixtureRoot();
    await writeState(root, { schemaVersion: 1, nope: true });
    const { exitCode, stdout } = await runCli(["persist", "status", "--json"], root);
    expect(exitCode).toBe(24);
    const parsed = JSON.parse(stdout) as { error: { id: string } };
    expect(parsed.error.id).toBe("STATE_INVALID");
    await rm(root, { recursive: true, force: true });
  });
});
