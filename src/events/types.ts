// 统一事件层 — 修复流与检测流的事件类型定义

import type { SignalResult, CheckResponse } from "../detection/types.js";

// ── 修复流事件 ──

export type FixEvent =
  | { type: "step-start"; stepId: string; name: string; oldValue?: string; newValue?: string; rollback?: boolean }
  | { type: "step-ok";    stepId: string; rollback?: boolean }
  | { type: "step-fail";  stepId: string; error: string; rollback?: boolean }
  | { type: "summary";    ok: number; fail: number; rolledBack: boolean; fatal?: boolean }
  | { type: "recheck";    before: number; after: number };

// ── 检测流事件 ──

export type DetectEvent =
  | { type: "phase";       label: string }
  | { type: "detect-start" }
  | { type: "detect-ok";   signal: SignalResult }
  | { type: "detect-degraded"; pluginId: string; error: string }
  | { type: "detect-done"; response: CheckResponse };

// ── 联合类型 ──

export type StreamEvent = FixEvent | DetectEvent;

// ── 消费者回调签名 ──

export type EventConsumer = (event: StreamEvent) => void;
