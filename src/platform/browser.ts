// 浏览器策略（Chrome/Edge HKCU）检测侧 I/O — 槽事实全部派生自 state/schema.ts 槽目录（ADR-0011）
// 规范词汇：槽 id（chrome.accept_language …）；slotKey 词汇已随旧修复流退役。

import { execFile } from "node:child_process";
import { BROWSER_POLICY_SLOTS, type BrowserId } from "../state/schema.js";

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

/**
 * 一次 reg query（无 /v）读取浏览器键下全部策略值，按 valueName 索引。
 * 替代逐槽位 spawn（#67 实测 6 次顺序 reg query 60-250ms）：Chrome/Edge 各一次，
 * 检测路径子进程数 6 → 2。键或值不存在返回 null；整个键失败返回全 null。
 */
export async function readPolicyValues(browser: BrowserId): Promise<Record<string, string | null>> {
  const entries = BROWSER_POLICY_SLOTS.filter((slot) => slot.browser === browser);
  const keyPath = entries[0]?.keyPath;
  if (keyPath === undefined) throw new Error(`Unmanaged browser policy browser: ${browser}`);
  try {
    const output = await runAsync("reg", ["query", keyPath]);
    const values: Record<string, string | null> = {};
    // reg.exe 输出为 CRLF：按 /\r?\n/ 切行，避免行尾 \r 使 `$` 锚匹配失败（#75 回归 -> 全部值被解析为 null）。
    for (const line of output.split(/\r?\n/u)) {
      // "    AcceptLanguage    REG_SZ    en-US"
      const match = line.match(/^\s*([^\s]+)\s+REG_SZ\s+(.+)$/);
      if (match !== null && match[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2].trim();
    }
    for (const slot of entries) values[slot.valueName] ??= null;
    return values;
  } catch {
    // 策略区不存在：全部槽位均为 null
    return Object.fromEntries(entries.map((slot) => [slot.valueName, null]));
  }
}
