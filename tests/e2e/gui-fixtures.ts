// GUI E2E fixture（T18）：spawn 真实 sidecar（dist/gui/sidecar.js），隔离 APPDATA，
// 等待 ready JSON，暴露 bootstrap URL 与 session；teardown 结束子进程。
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createCheckedEnvelope, serializeCheckedEnvelope } from "../../src/state/checksum.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const sidecarEntry = join(repoRoot, "dist", "gui", "sidecar.js");
const STATE_SCHEMA = "cc-fix-state-v1";

export type GuiHarness = {
  baseUrl: string;
  appData: string;
  stop: () => Promise<void>;
};

function ensureBundle(): void {
  if (!existsSync(sidecarEntry)) {
    execFileSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit" });
  }
}

/** 启动一次隔离的 GUI 会话（随机端口 + 高熵会话令牌 + 临时 APPDATA）。 */
export async function startGuiHarness(fixture?: { state?: unknown }): Promise<GuiHarness> {
  ensureBundle();
  const appData = await mkdtemp(join(tmpdir(), "cc-fix-gui-e2e-"));
  if (fixture?.state !== undefined) {
    const stateRoot = join(appData, "cc-fix");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "state.json"),
      serializeCheckedEnvelope(createCheckedEnvelope(STATE_SCHEMA, fixture.state as never)),
      "utf-8",
    );
  }

  const token = randomBytes(32).toString("base64url");
  const sessionId = randomBytes(32).toString("base64url");

  const child: ChildProcess = spawn(process.execPath, [sidecarEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CC_FIX_GUI_TOKEN: token,
      CC_FIX_GUI_SESSION_ID: sessionId,
      APPDATA: appData,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const ready = await new Promise<{ url: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sidecar ready timeout")), 20_000);
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const parsed = JSON.parse(trimmed) as { type?: string; url?: string };
          if (parsed.type === "ready" && typeof parsed.url === "string") {
            clearTimeout(timer);
            resolve({ url: parsed.url });
            return;
          }
        } catch {
          // 非 JSON 行（如告警）忽略
        }
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`sidecar exited early with code ${code}`));
    });
  });

  const harness: GuiHarness = {
    baseUrl: ready.url,
    appData,
    stop: async () => {
      if (child.exitCode === null && child.pid !== undefined) {
        child.kill();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
      await rm(appData, { recursive: true, force: true });
    },
  };
  return harness;
}

/** 有效状态夹具：daily（无保护提交）。 */
export function dailyState() {
  return {
    schemaVersion: 1,
    revision: 1,
    committedTarget: null,
    preferredRegion: "us",
    health: "healthy",
    degradation: [],
    activeTransactionId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** 有效状态夹具：standard/us 已提交。 */
export function standardState() {
  return {
    schemaVersion: 1,
    revision: 2,
    committedTarget: { mode: "standard", region: "us" },
    preferredRegion: "us",
    health: "healthy",
    degradation: [],
    activeTransactionId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** 有效状态夹具：deep/jp 已提交（非 US 转换基线）。 */
export function deepJapanState() {
  return {
    schemaVersion: 1,
    revision: 3,
    committedTarget: { mode: "deep", region: "jp" },
    preferredRegion: "jp",
    health: "healthy",
    degradation: [],
    activeTransactionId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** 恢复页夹具：activeTransactionId 非空且无 journal → recovery_required。 */
export function recoveryRequiredState() {
  return {
    schemaVersion: 1,
    revision: 4,
    committedTarget: null,
    preferredRegion: "us",
    health: "healthy",
    degradation: [],
    activeTransactionId: "t-e2e-recovery",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
