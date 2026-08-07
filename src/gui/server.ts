// Web UI 服务模块 — SSE 常驻通道 + 触发端点

import http from "node:http";
// @ts-ignore - HTML file imported as text via tsup loader
import htmlContent from "./index.html";
import { runDetection } from "../detection/runner.js";
import { getTargetRegion, DEFAULT_REGION, TARGET_REGIONS } from "../detection/regions.js";
import { fetchIpIntelligence } from "../proxy/ip-intel.js";
import { getPersistStatus } from "../platform/windows.js";
import { persistOnFlow, persistOffFlow } from "../fix/flow.js";
import { recordFixSummary, recordCheck, readHistory } from "../fix/history.js";
import type { StreamEvent } from "../events/types.js";

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

// 包装事件消费：透传广播、记录操作日志并维护 recheck 状态
// 日志先于广播写入，前端收到 summary 后拉取历史时不会落空
function fixEventConsumer(action: "persist-on" | "persist-off") {
  return (e: StreamEvent) => {
    if (e.type === "summary") {
      recordFixSummary(action, e);
    }
    broadcast(e);
    if (e.type === "summary" && e.fail === 0 && !e.fatal && lastDetectScore !== null) {
      pendingRecheck = lastDetectScore;
    }
  };
}

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
  if (!tryAcquireLock(res)) return;
  res.writeHead(202); res.end();

  // 非法/缺省 region 由 getTargetRegion 回落到 DEFAULT_REGION（与 CLI 同一事实源）
  const regionCode = url.searchParams.get("region") || DEFAULT_REGION;
  const target = getTargetRegion(regionCode);
  try {
    await persistOnFlow(
      { regionCode: target.code, targetTimezone: target.timezone, targetWinTimezone: target.winTimezone, targetLang: target.lang, targetLcAll: target.lcAll },
      fixEventConsumer("persist-on"),
    );
  } finally {
    releaseLock();
  }
}

async function handleFixOff(res: http.ServerResponse) {
  if (!tryAcquireLock(res)) return;
  res.writeHead(202); res.end();

  try {
    await persistOffFlow(fixEventConsumer("persist-off"));
  } finally {
    releaseLock();
  }
}

async function handleCheckStart(res: http.ServerResponse) {
  if (!tryAcquireLock(res)) return;
  res.writeHead(202); res.end();

  const target = getTargetRegion(DEFAULT_REGION);
  try {
    const ipIntel = await fetchIpIntelligence();
    await runDetection("auto", target.timezone, target.lang, ipIntel, checkEventConsumer);
  } finally {
    releaseLock();
  }
}

async function handleStatus(res: http.ServerResponse) {
  const status = getPersistStatus();
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

export function startGuiServer(port = 3456): Promise<http.Server> {
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
      console.error("GUI 错误:", err);
      sendJson(res, { error: String(err) }, 500);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    });
  });
}
