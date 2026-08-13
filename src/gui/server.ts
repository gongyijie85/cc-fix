// Web UI 服务模块 — SSE 常驻通道 + 触发端点

import http from "node:http";
// @ts-ignore - HTML file imported as text via tsup loader
import htmlContent from "./index.html";
import { runDetection } from "../detection/runner.js";
import { getTargetRegion, DEFAULT_REGION, TARGET_REGIONS } from "../detection/regions.js";
import { fetchIpIntelligence } from "../proxy/ip-intel.js";
import { recordFixSummary, recordCheck, readHistory } from "../fix/history.js";
import type { StreamEvent } from "../events/types.js";
import { RegionResolutionError } from "../domain/region.js";
import { parseRegionCode, resolveRegion } from "../domain/region.js";
import { resolveProtectionRequest } from "../domain/protection.js";
import { createPersistRuntime } from "../persist/runtime.js";
import type { PersistApplicationService } from "../persist/application.js";

function sendJson(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

async function serveHtml(res: http.ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(htmlContent);
}

// ── SSE 常驻通道 ──

const clients = new Set<http.ServerResponse>();

function broadcast(event: StreamEvent) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    if (res.writableEnded || res.destroyed) {
      clients.delete(res);
      continue;
    }
    res.write(data);
  }
}

// ── 全局锁 ──

let busy = false;

function tryAcquireLock(res: http.ServerResponse): boolean {
  if (busy) {
    sendJson(res, { error: "操作进行中" }, 409);
    return false;
  }
  busy = true;
  return true;
}

function releaseLock() {
  busy = false;
}

// ── 评分对比（recheck）状态 ──

let lastDetectScore: number | null = null;
let pendingRecheck: number | null = null;

function checkEventConsumer(e: StreamEvent) {
  if (e.type === "detect-done") {
    recordCheck(e.response.score);
  }
  broadcast(e);
  if (e.type === "detect-done") {
    lastDetectScore = e.response.score;
    if (pendingRecheck !== null) {
      broadcast({ type: "recheck", before: pendingRecheck, after: e.response.score });
      pendingRecheck = null;
    }
  }
}

// ── 触发端点处理 ──

async function handleFixOn(res: http.ServerResponse, url: URL) {
  const requestedRegion = url.searchParams.get("region");
  if (requestedRegion !== null) parseRegionCode(requestedRegion, "explicit");
  const requestedLevel = url.searchParams.get("level") ?? undefined;

  if (!tryAcquireLock(res)) return;
  res.writeHead(202); res.end();

  try {
    const runtime = await runtimeFactory();
    const status = await runtime.status();
    const region = resolveRegion({ explicit: requestedRegion ?? undefined, active: status.target?.region, preferred: status.preferredRegion });
    const target = resolveProtectionRequest({ currentMode: status.mode, resolvedRegion: region, level: requestedLevel });
    broadcast({ type: "step-start", stepId: "persist", name: `切换到 ${target.mode} / ${target.region}` });
    const result = await runtime.protect(target);
    const failed = result.kind === "compensated" || result.kind === "recovery_required";
    const summary = { type: "summary" as const, ok: failed ? 0 : 1, fail: failed ? 1 : 0, rolledBack: result.kind === "compensated", fatal: result.kind === "recovery_required" };
    if (failed) broadcast({ type: "step-fail", stepId: "persist", error: `事务结果: ${result.kind}` });
    else broadcast({ type: "step-ok", stepId: "persist" });
    if (!failed && lastDetectScore !== null) pendingRecheck = lastDetectScore;
    recordFixSummary("persist-on", summary);
    broadcast(summary);
  } catch (error) {
    broadcast({ type: "step-fail", stepId: "persist", error: error instanceof Error ? error.message : String(error) });
    const summary = { type: "summary" as const, ok: 0, fail: 1, rolledBack: false, fatal: true };
    recordFixSummary("persist-on", summary); broadcast(summary);
  } finally {
    releaseLock();
  }
}

async function handleFixOff(res: http.ServerResponse) {
  if (!tryAcquireLock(res)) return;
  res.writeHead(202); res.end();

  try {
    broadcast({ type: "step-start", stepId: "persist", name: "还原日常配置" });
    const result = await (await runtimeFactory()).restore();
    const failed = result.kind === "recovery_required";
    if (failed) broadcast({ type: "step-fail", stepId: "persist", error: `未完成项: ${result.failed.join(", ")}` });
    else broadcast({ type: "step-ok", stepId: "persist" });
    if (!failed && lastDetectScore !== null) pendingRecheck = lastDetectScore;
    const summary = { type: "summary" as const, ok: failed ? 0 : 1, fail: failed ? 1 : 0, rolledBack: false, fatal: failed };
    recordFixSummary("persist-off", summary); broadcast(summary);
  } catch (error) {
    broadcast({ type: "step-fail", stepId: "persist", error: error instanceof Error ? error.message : String(error) });
    const summary = { type: "summary" as const, ok: 0, fail: 1, rolledBack: false, fatal: true };
    recordFixSummary("persist-off", summary); broadcast(summary);
  } finally {
    releaseLock();
  }
}

async function handleCheckStart(res: http.ServerResponse) {
  if (!tryAcquireLock(res)) return;
  res.writeHead(202); res.end();

  try {
    const status = await (await runtimeFactory()).status();
    const target = getTargetRegion(status.target?.region ?? status.preferredRegion);
    const ipIntel = await fetchIpIntelligence();
    await runDetection("auto", target.timezone, target.lang, ipIntel, checkEventConsumer);
  } finally {
    releaseLock();
  }
}

async function handleStatus(res: http.ServerResponse) {
  const status = await (await runtimeFactory()).status();
  sendJson(res, status);
}

async function handleHistory(res: http.ServerResponse) {
  sendJson(res, readHistory(10));
}

function handleRegions(res: http.ServerResponse) {
  sendJson(res, {
    default: DEFAULT_REGION,
    regions: Object.values(TARGET_REGIONS).map(r => ({ code: r.code, name: r.name })),
  });
}

// ── 服务器 ──

let runtimeFactory: () => Promise<PersistApplicationService> = createPersistRuntime;

export function startGuiServer(
  port = 3456,
  dependencies?: Readonly<{ createRuntime?: () => Promise<PersistApplicationService> }>,
): Promise<http.Server> {
  runtimeFactory = dependencies?.createRuntime ?? createPersistRuntime;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const method = req.method?.toUpperCase() || "GET";

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    try {
      if (method === "GET" && url.pathname === "/") {
        await serveHtml(res);
      } else if (method === "GET" && url.pathname === "/api/events") {
        // SSE 常驻通道
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write("\n");
        clients.add(res);
        res.on("error", () => clients.delete(res));
        req.on("close", () => clients.delete(res));
      } else if (method === "GET" && url.pathname === "/api/status") {
        await handleStatus(res);
      } else if (method === "GET" && url.pathname === "/api/history") {
        await handleHistory(res);
      } else if (method === "GET" && url.pathname === "/api/regions") {
        handleRegions(res);
      } else if (method === "POST" && url.pathname === "/api/fix/on") {
        await handleFixOn(res, url);
      } else if (method === "POST" && url.pathname === "/api/fix/off") {
        await handleFixOff(res);
      } else if (method === "POST" && url.pathname === "/api/check/start") {
        await handleCheckStart(res);
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

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    });
  });
}
