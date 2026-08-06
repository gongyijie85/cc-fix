// Web UI 服务模块 — 本地 HTTP 服务器 + API 路由

import http from "node:http";
// @ts-ignore - HTML file imported as text via tsup loader
import htmlContent from "./index.html";
import { runDetection } from "../detection/runner.js";
import { getTargetRegion, DEFAULT_REGION } from "../detection/regions.js";
import { fetchIpIntelligence } from "../proxy/ip-intel.js";
import {
  createBackup,
  restoreBackup,
  getPersistStatus,
  setEnvVar,
} from "../platform/windows.js";

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

async function handleCheck(res: http.ServerResponse) {
  const target = getTargetRegion(DEFAULT_REGION);
  const ipIntel = await fetchIpIntelligence();
  const response = await runDetection("auto", target.timezone, target.lang, ipIntel);
  sendJson(res, response);
}

async function handleStatus(res: http.ServerResponse) {
  const status = getPersistStatus();
  sendJson(res, status);
}

async function handlePersistOn(res: http.ServerResponse) {
  const target = getTargetRegion(DEFAULT_REGION);
  const envKeys = ["TZ", "LANG", "LC_ALL"];
  createBackup(envKeys);
  setEnvVar("TZ", target.timezone);
  setEnvVar("LANG", target.lang);
  setEnvVar("LC_ALL", target.lcAll);
  sendJson(res, { success: true, region: target.name });
}

async function handlePersistOff(res: http.ServerResponse) {
  const status = getPersistStatus();
  if (!status.enabled || !status.backup) {
    sendJson(res, { success: false, error: "持久化未开启" }, 400);
    return;
  }
  restoreBackup(status.backup);
  sendJson(res, { success: true });
}

export function startGuiServer(port = 3456): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const method = req.method?.toUpperCase() || "GET";

    try {
      // 路由
      if (method === "GET" && url.pathname === "/") {
        await serveHtml(res);
      } else if (method === "GET" && url.pathname === "/api/check") {
        await handleCheck(res);
      } else if (method === "GET" && url.pathname === "/api/status") {
        await handleStatus(res);
      } else if (method === "POST" && url.pathname === "/api/persist/on") {
        await handlePersistOn(res);
      } else if (method === "POST" && url.pathname === "/api/persist/off") {
        await handlePersistOff(res);
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
