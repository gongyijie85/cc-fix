// Web UI 服务模块 — SSE 常驻通道 + 触发端点

import http from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
// @ts-ignore - HTML file imported as text via tsup loader
import htmlContent from "./index.html";
import { runDetection } from "../detection/runner.js";
import { getTargetRegion, DEFAULT_REGION, TARGET_REGIONS } from "../detection/regions.js";
import { fetchIpIntelligence } from "../proxy/ip-intel.js";
import type { IpIntelligence } from "../detection/types.js";
import { recordFixSummary, recordCheck, readHistory } from "../fix/history.js";
import type { StreamEvent } from "../events/types.js";
import { RegionResolutionError } from "../domain/region.js";
import { parseRegionCode, resolveRegion } from "../domain/region.js";
import { resolveProtectionRequest } from "../domain/protection.js";
import { createPersistRuntime } from "../persist/runtime.js";
import type { PersistApplicationService } from "../persist/application.js";
import { GuiSession } from "./session.js";
import { detectRunningBrowsers } from "../platform/browser.js";
import { createFontFixService } from "../fonts/service.js";
import { defaultPersistRoot } from "../state/paths.js";
import { recordFontAction } from "../fix/history.js";
import { signalCatalog } from "../detection/catalog.js";

function sendJson(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

async function serveHtml(res: http.ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(htmlContent);
}

// ── 每实例编排器（评审候选 7）：busy 门 / SSE fan-out / recheck 簿记 / runtime 工厂 ──

type GuiRuntimeFactory = () => Promise<PersistApplicationService>;
type GuiIpIntelFetcher = () => Promise<IpIntelligence | null>;

function createGuiOrchestrator(createRuntime: GuiRuntimeFactory, ipIntelFetcher: GuiIpIntelFetcher) {
  const clients = new Set<http.ServerResponse>();
  // #62：SSE 连接上限（本地认证后仍作纵深；防止异常页面/调试连接堆积）
  const MAX_SSE_CLIENTS = 16;
  let busy = false;
  let lastDetectScore: number | null = null;
  let pendingRecheck: number | null = null;

  const broadcast = (event: StreamEvent) => {
    const data = `data: ${JSON.stringify(event)}

`;
    for (const res of clients) {
      if (res.writableEnded || res.destroyed) {
        clients.delete(res);
        continue;
      }
      res.write(data);
    }
  };

  let runtimePromise: Promise<PersistApplicationService> | undefined;
  let fontFixPromise: ReturnType<typeof createFontFixService> | undefined;
  const getFontFix = () => {
    fontFixPromise ??= createFontFixService({ stateRoot: defaultPersistRoot(process.env) });
    return fontFixPromise;
  };
  // 单飞缓存（issue #44）：并发请求复用同一运行时，避免重复迁移在同进程内撞迁移锁。
  // 仓库每次操作都重读文件，缓存无状态过期；初始化失败清缓存以允许重试。
  const getRuntime = (): Promise<PersistApplicationService> => {
    runtimePromise ??= createRuntime().catch((error: unknown) => {
      runtimePromise = undefined;
      throw error;
    });
    return runtimePromise;
  };

  return Object.freeze({
    getFontFix,
    broadcast,
    attachSse: (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
      if (clients.size >= MAX_SSE_CLIENTS) return false;
      clients.add(res);
      // #86：浏览器连接即后台预取 IP 情报（TTL 60s 缓存，失败静默等下次检测重取）
      void ipIntelFetcher().catch(() => undefined);
      res.on("error", () => clients.delete(res));
      req.on("close", () => clients.delete(res));
      return true;
    },
    tryAcquireLock: (res: http.ServerResponse): boolean => {
      if (busy) {
        sendJson(res, { error: "操作进行中" }, 409);
        return false;
      }
      busy = true;
      return true;
    },
    releaseLock: () => { busy = false; },
    getRuntime,
    ipIntelFetcher,
    markPendingRecheckIfKnown: () => { if (lastDetectScore !== null) pendingRecheck = lastDetectScore; },
    checkEventConsumer: (e: StreamEvent) => {
      if (e.type === "detect-done") {
        void recordCheck(e.response.score);
      }
      broadcast(e);
      if (e.type === "detect-done") {
        lastDetectScore = e.response.score;
        if (pendingRecheck !== null) {
          broadcast({ type: "recheck", before: pendingRecheck, after: e.response.score });
          pendingRecheck = null;
        }
      }
    },
  });
}

// ── 触发端点处理 ──

type PersistStepOutcome = {
  failed: boolean;
  fatal: boolean;
  rolledBack: boolean;
  error?: string;
  degraded?: string[];
};

/** persist 三步骤的共享骨架：锁 → 202 → step-start → 工作 → step-ok/fail → summary（catch 时 fatal summary）→ 释放锁。
 * prepare 返回 { name, ...contxt }，ctx 传入 execute 复用（fix/on 需在命名前解析目标）。 */
async function runPersistStep<C extends { name: string }>(
  orchestrator: ReturnType<typeof createGuiOrchestrator>,
  res: http.ServerResponse,
  step: {
    stepId: string;
    historyName?: "persist-on" | "persist-off";
    prepare?: () => Promise<C>;
    execute: (ctx: C) => Promise<PersistStepOutcome>;
    onSuccess?: (outcome: PersistStepOutcome) => void;
  },
): Promise<void> {
  if (!orchestrator.tryAcquireLock(res)) return;
  res.writeHead(202);
  res.end();

  try {
    const ctx = (await step.prepare?.()) ?? ({ name: step.stepId } as C);
    orchestrator.broadcast({ type: "step-start", stepId: step.stepId, name: ctx.name });
    const outcome = await step.execute(ctx);
    if (outcome.failed) {
      orchestrator.broadcast({ type: "step-fail", stepId: step.stepId, error: outcome.error ?? "步骤失败" });
    } else {
      orchestrator.broadcast({ type: "step-ok", stepId: step.stepId });
      step.onSuccess?.(outcome);
    }
    const summary = {
      type: "summary" as const,
      ok: outcome.failed ? 0 : 1,
      fail: outcome.failed ? 1 : 0,
      rolledBack: outcome.rolledBack,
      fatal: outcome.fatal,
      ...(outcome.degraded ? { degraded: outcome.degraded } : {}),
    };
    if (step.historyName) void recordFixSummary(step.historyName, summary);
    orchestrator.broadcast(summary);
  } catch (error) {
    orchestrator.broadcast({ type: "step-fail", stepId: step.stepId, error: error instanceof Error ? error.message : String(error) });
    const summary = { type: "summary" as const, ok: 0, fail: 1, rolledBack: false, fatal: true };
    if (step.historyName) void recordFixSummary(step.historyName, summary);
    orchestrator.broadcast(summary);
  } finally {
    orchestrator.releaseLock();
  }
}

async function handleFixOn(orchestrator: ReturnType<typeof createGuiOrchestrator>, res: http.ServerResponse, url: URL) {
  const requestedRegion = url.searchParams.get("region");
  if (requestedRegion !== null) parseRegionCode(requestedRegion, "explicit");
  const requestedLevel = url.searchParams.get("level") ?? undefined;

  await runPersistStep(orchestrator, res, {
    stepId: "persist",
    historyName: "persist-on",
    prepare: async () => {
      const runtime = await orchestrator.getRuntime();
      const status = await runtime.status();
      const region = resolveRegion({ explicit: requestedRegion ?? undefined, active: status.target?.region, preferred: status.preferredRegion });
      const target = resolveProtectionRequest({ currentMode: status.mode, resolvedRegion: region, level: requestedLevel });
      return { name: `切换到 ${target.mode} / ${target.region}`, target };
    },
    execute: async ({ target }) => {
      const result = await (await orchestrator.getRuntime()).protect(target);
      const failed = result.kind === "compensated" || result.kind === "recovery_required";
      // degraded：事务已提交、非失败（ok=1），但浏览器策略槽有未对齐项，随 summary 单独呈现（issue #50）。
      const degraded = result.kind === "degraded" ? result.degraded.map((reason) => reason.slot) : undefined;
      return {
        failed,
        rolledBack: result.kind === "compensated",
        fatal: result.kind === "recovery_required",
        ...(failed ? { error: `事务结果: ${result.kind}` } : {}),
        ...(degraded ? { degraded } : {}),
      };
    },
    onSuccess: () => {
      orchestrator.markPendingRecheckIfKnown();
      // 待生效提示（ADR-0006）：策略写入后探测运行中的浏览器。
      // 异步探测（issue #61）：不阻塞事件循环；detectRunningBrowsers 内部吞掉失败，不会抛出。
      setImmediate(() => {
        void Promise.resolve(detectRunningBrowsers()).then((running) => {
          orchestrator.broadcast({ type: "browser-hint", running });
        });
      });
    },
  });
}

async function handleFixOff(orchestrator: ReturnType<typeof createGuiOrchestrator>, res: http.ServerResponse) {
  await runPersistStep(orchestrator, res, {
    stepId: "persist",
    historyName: "persist-off",
    prepare: async () => ({ name: "还原日常配置" }),
    execute: async () => {
      const result = await (await orchestrator.getRuntime()).restore();
      const failed = result.kind === "recovery_required";
      return {
        failed,
        rolledBack: false,
        fatal: failed,
        ...(failed ? { error: `未完成项: ${result.failed.join(", ")}` } : {}),
      };
    },
    onSuccess: () => orchestrator.markPendingRecheckIfKnown(),
  });
}

async function handleRecover(orchestrator: ReturnType<typeof createGuiOrchestrator>, res: http.ServerResponse) {
  await runPersistStep(orchestrator, res, {
    stepId: "persist",
    prepare: async () => ({ name: "继续未完成的恢复事务" }),
    execute: async () => {
      const result = await (await orchestrator.getRuntime()).recover();
      const failed = result.kind === "recovery_required";
      return {
        failed,
        rolledBack: false,
        fatal: failed,
        ...(failed ? { error: `仍未恢复项: ${result.failed.join(", ")}` } : {}),
      };
    },
  });
}

async function handleCheckStart(orchestrator: ReturnType<typeof createGuiOrchestrator>, res: http.ServerResponse) {
  if (!orchestrator.tryAcquireLock(res)) return;
  res.writeHead(202); res.end();

  try {
    orchestrator.broadcast({ type: "phase", label: "正在获取 IP 情报…" });
    const status = await (await orchestrator.getRuntime()).status();
    const target = getTargetRegion(status.target?.region ?? status.preferredRegion);
    const ipIntel = await orchestrator.ipIntelFetcher();
    await runDetection("auto", target.timezone, target.lang, ipIntel, orchestrator.checkEventConsumer);
  } finally {
    orchestrator.releaseLock();
  }
}

async function handleStatus(orchestrator: ReturnType<typeof createGuiOrchestrator>, res: http.ServerResponse) {
  const status = await (await orchestrator.getRuntime()).status();
  sendJson(res, status);
}

async function handleHistory(res: http.ServerResponse) {
  sendJson(res, await readHistory(10));
}

function handleRegions(res: http.ServerResponse) {
  sendJson(res, {
    default: DEFAULT_REGION,
    regions: Object.values(TARGET_REGIONS).map(r => ({ code: r.code, name: r.name })),
  });
}


async function handleFontsStatus(orchestrator: ReturnType<typeof createGuiOrchestrator>, res: http.ServerResponse) {
  sendJson(res, { ...(await orchestrator.getFontFix().status()), removalEnabled: false });
}

const FONT_ASSET_NAME = "cc-fix-noto-sans-sc.woff2";
const FONT_ASSET_SHA256 = "C3BED59129B34D5F5B6BDCAE207748491DC0A919E4F0BBE8108B156BC7E9A2D9";
const GUI_ASSETS = Object.freeze({
  "app.css": "text/css; charset=utf-8",
  "app.js": "application/javascript; charset=utf-8",
  "renderers.js": "application/javascript; charset=utf-8",
  "state.js": "application/javascript; charset=utf-8",
});

async function readBundledAsset(directory: string, name: string): Promise<Buffer | undefined> {
  const candidates = [
    fileURLToPath(new URL(`../assets/${directory}/${name}`, import.meta.url)),
    fileURLToPath(new URL(`../../assets/${directory}/${name}`, import.meta.url)),
  ];
  for (const candidate of candidates) {
    try { return await readFile(candidate); } catch { /* source tree vs bundled dist */ }
  }
  return undefined;
}

async function serveGuiAsset(res: http.ServerResponse, name: keyof typeof GUI_ASSETS) {
  const body = await readBundledAsset("gui", name);
  if (!body) {
    res.writeHead(404, { "Cache-Control": "no-store" });
    res.end("Not found");
    return;
  }
  const etag = createHash("sha256").update(body).digest("hex");
  res.writeHead(200, {
    "Content-Type": GUI_ASSETS[name],
    "Content-Length": body.byteLength,
    "Cache-Control": "no-cache",
    "ETag": `\"${etag}\"`,
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  res.end(body);
}

async function serveFont(res: http.ServerResponse) {
  const body = await readBundledAsset("fonts", FONT_ASSET_NAME);
  if (!body) {
    res.writeHead(404, { "Cache-Control": "no-store" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "font/woff2",
    "Content-Length": body.byteLength,
    "Cache-Control": "public, max-age=31536000, immutable",
    "ETag": `"${FONT_ASSET_SHA256}"`,
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  res.end(body);
}

async function handleFontsRestore(orchestrator: ReturnType<typeof createGuiOrchestrator>, res: http.ServerResponse) {
  if (!orchestrator.tryAcquireLock(res)) return;
  res.writeHead(202); res.end();
  try {
    orchestrator.broadcast({ type: "step-start", stepId: "fonts", name: "还原中文字体" });
    const result = await orchestrator.getFontFix().restore();
    if (!result.ok) {
      orchestrator.broadcast({ type: "step-fail", stepId: "fonts", error: result.error });
      orchestrator.broadcast({ type: "summary", ok: 0, fail: 1, rolledBack: false, fatal: true });
    } else {
      orchestrator.broadcast({ type: "step-ok", stepId: "fonts" });
      orchestrator.broadcast({ type: "summary", ok: 1, fail: 0, rolledBack: false, fatal: false });
    }
    void recordFontAction("font-restore");
  } catch (error) {
    orchestrator.broadcast({ type: "step-fail", stepId: "fonts", error: error instanceof Error ? error.message : String(error) });
    orchestrator.broadcast({ type: "summary", ok: 0, fail: 1, rolledBack: false, fatal: true });
  } finally {
    orchestrator.releaseLock();
  }
}
// ── 服务器 ──

export type GuiHttpServer = http.Server & Readonly<{
  ccFixSession: GuiSession;
  bootstrapUrl(): string;
}>;

export function startGuiServer(
  port = 3456,
  dependencies?: Readonly<{ createRuntime?: () => Promise<PersistApplicationService>; session?: GuiSession; ipIntelFetcher?: GuiIpIntelFetcher }>,
): Promise<GuiHttpServer> {
  const orchestrator = createGuiOrchestrator(dependencies?.createRuntime ?? createPersistRuntime, dependencies?.ipIntelFetcher ?? fetchIpIntelligence);
  const session = dependencies?.session ?? new GuiSession();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const method = req.method?.toUpperCase() || "GET";

    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : port;
    const expectedOrigin = `http://127.0.0.1:${actualPort}`;
    if (method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
      if (session.bootstrap(req, res, url.searchParams.get("token"), expectedOrigin)) return;
      sendJson(res, { error: "invalid_or_used_bootstrap_token" }, 401);
      return;
    }
    const isApi = url.pathname.startsWith('/api/');
    if (!session.authorize(req, expectedOrigin, isApi)) {
      sendJson(res, { error: "unauthorized_local_session" }, 401);
      return;
    }

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": expectedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    try {
      if (method === "GET" && url.pathname === "/") {
        await serveHtml(res);
      } else if (method === "GET" && url.pathname === "/assets/gui/app.css") {
        await serveGuiAsset(res, "app.css");
      } else if (method === "GET" && url.pathname === "/assets/gui/app.js") {
        await serveGuiAsset(res, "app.js");
      } else if (method === "GET" && url.pathname === "/assets/gui/renderers.js") {
        await serveGuiAsset(res, "renderers.js");
      } else if (method === "GET" && url.pathname === "/assets/gui/state.js") {
        await serveGuiAsset(res, "state.js");
      } else if (method === "GET" && url.pathname === `/assets/fonts/${FONT_ASSET_NAME}`) {
        await serveFont(res);
      } else if (method === "GET" && url.pathname === "/api/events") {
        // #62：SSE 连接上限——先检查再写 SSE 头，超限走 429
        if (!orchestrator.attachSse(req, res)) {
          sendJson(res, { error: "too_many_sse_connections" }, 429);
          return;
        }
        // SSE 常驻通道
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        res.write("\n");
        res.write(`data: ${JSON.stringify({ type: 'catalog' as const, signals: signalCatalog() })}

`);
      } else if (method === "GET" && url.pathname === "/api/status") {
        await handleStatus(orchestrator, res);
      } else if (method === "GET" && url.pathname === "/api/history") {
        await handleHistory(res);
      } else if (method === "GET" && url.pathname === "/api/regions") {
        handleRegions(res);
      } else if (method === "POST" && url.pathname === "/api/fix/on") {
        await handleFixOn(orchestrator, res, url);
      } else if (method === "POST" && url.pathname === "/api/fix/off") {
        await handleFixOff(orchestrator, res);
      } else if (method === "POST" && url.pathname === "/api/fix/recover") {
        await handleRecover(orchestrator, res);
      } else if (method === "GET" && url.pathname === "/api/fonts/status") {
        await handleFontsStatus(orchestrator, res);
      } else if (method === "POST" && url.pathname === "/api/fonts/remove") {
        sendJson(res, {
          error: "font_removal_disabled",
          message: "中文字体移除功能已停用；已有备份仍可还原",
        }, 410);
      } else if (method === "POST" && url.pathname === "/api/fonts/restore") {
        await handleFontsRestore(orchestrator, res);
      } else if (method === "POST" && url.pathname === "/api/check/start") {
        await handleCheckStart(orchestrator, res);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    } catch (err) {
      if (err instanceof RegionResolutionError) {
        sendJson(res, {
          error: {
            code: err.code,
            source: err.source,
            value: err.value,
            validRegions: err.validRegions,
          },
        }, 400);
        return;
      }
      console.error("GUI 错误:", err);
      if (res.headersSent || res.writableEnded) return;
      sendJson(res, { error: String(err) }, 500);
    }
  });

  const guiServer = server as GuiHttpServer;
  Object.defineProperties(guiServer, {
    ccFixSession: { value: session, enumerable: false },
    bootstrapUrl: { value: () => {
      const address = guiServer.address();
      if (typeof address !== 'object' || address === null) throw new Error('GUI server is not listening');
      return `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(session.bootstrapToken)}`;
    }, enumerable: false },
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve(guiServer);
      // #89 首启预热：提前初始化 persist 运行时（懒加载单例），让首个真实 /api/status 只需 ~4ms
      // 而非 223ms 的初始化成本。fire-and-forget，失败静默，不影响服务可用性与既有语义。
      // 预热初始化一次后，后续 status/fix 请求复用同一运行时，issue #44 的单飞计数不变。
      void (async () => { try { await (await orchestrator.getRuntime()).status(); } catch {} })();
    });
  });
}
