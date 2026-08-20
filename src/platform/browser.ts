// 浏览器策略（Chrome/Edge HKCU）检测侧 I/O — 槽事实全部派生自 state/schema.ts 槽目录（ADR-0011）
// 规范词汇：槽 id（chrome.accept_language …）；slotKey 词汇已随旧修复流退役。

import { execFile } from "node:child_process";
import { BROWSER_POLICY_SLOTS, type BrowserId, type BrowserPolicySlotId } from "../state/schema.js";

export type { BrowserId } from "../state/schema.js";

export const BROWSER_LABELS: Record<BrowserId, string> = {
  chrome: "Chrome",
  edge: "Edge",
};

// 进程名 → 浏览器（tasklist 的 IMAGENAME）
const PROCESS_IMAGES: Record<string, BrowserId> = {
  "chrome.exe": "chrome",
  "msedge.exe": "edge",
};

/** 子进程执行（异步，不阻塞事件循环——issue #61）。返回 stdout；失败 reject。 */
function runAsync(command: string, args: string[], timeoutMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: "utf8", windowsHide: true, ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
    child.stdout?.resume();
  });
}

/**
 * 探测正在运行的浏览器（异步，issue #61）：一次 `tasklist /NH` 列出全部进程，
 * 内存里匹配多个镜像名——避免逐浏览器 spawn（每次同步阻塞 30-100ms，GUI SSE
 * 常驻服务里会冻结整个事件循环）。tasklist 整体失败时降级返回空（不阻断调用方）。
 * 注意：tasklist 的多个 /FI 过滤器按 AND 连接，IMAGENAME 不可能同时等于两个值（恒假），
 * 必须一次性列全量后内存匹配（E2E-17 实测：组合查询即使 chrome.exe 运行中也返回空）。
 */
export async function detectRunningBrowsers(): Promise<BrowserId[]> {
  const running = new Set<BrowserId>();
  try {
    const output = await runAsync("tasklist", ["/NH"], 3_000);
    for (const line of output.split("\n")) {
      const image = line.trim().split(/\s+/)[0]?.toLowerCase();
      if (image === undefined) continue;
      const browser = PROCESS_IMAGES[image];
      if (browser !== undefined) running.add(browser);
    }
  } catch {
    // tasklist 失败：返回空结果
  }
  return [...running];
}

/** 按槽 id 读 HKCU 策略值（异步，issue #61）；键或值不存在返回 null。槽 id 必须来自目录。 */
export async function getPolicy(slot: BrowserPolicySlotId): Promise<string | null> {
  const entry = BROWSER_POLICY_SLOTS.find((candidate) => candidate.id === slot);
  if (entry === undefined) throw new Error(`Unmanaged browser policy slot: ${slot}`);
  try {
    const result = await runAsync("reg", ["query", entry.keyPath, "/v", entry.valueName]);
    const match = result.match(/REG_SZ\s+(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    // 策略区或值不存在
    return null;
  }
}
