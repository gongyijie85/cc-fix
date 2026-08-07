// 编排层测试 — persistOnFlow / persistOffFlow 事件序列验证

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "../events/types.js";

// Mock windows 平台模块
vi.mock("../platform/windows.js", () => ({
  createBackup: vi.fn(),
  setEnvVar: vi.fn(),
  deleteEnvVar: vi.fn(),
  getEnvVar: vi.fn(),
  getPersistStatus: vi.fn(),
}));

import { persistOnFlow, persistOffFlow } from "./flow.js";
import {
  createBackup,
  setEnvVar,
  deleteEnvVar,
  getEnvVar,
  getPersistStatus,
} from "../platform/windows.js";

const mockedCreateBackup = vi.mocked(createBackup);
const mockedSetEnvVar = vi.mocked(setEnvVar);
const mockedDeleteEnvVar = vi.mocked(deleteEnvVar);
const mockedGetEnvVar = vi.mocked(getEnvVar);
const mockedGetPersistStatus = vi.mocked(getPersistStatus);

let events: StreamEvent[];

function collectEvents() {
  events = [];
  return (e: StreamEvent) => { events.push(e); };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // 默认：getEnvVar 返回 null（变量未设置）
  mockedGetEnvVar.mockReturnValue(null);
  mockedSetEnvVar.mockImplementation(() => {});
  mockedDeleteEnvVar.mockImplementation(() => {});
});

describe("persistOnFlow", () => {
  const opts = {
    regionCode: "us",
    targetTimezone: "America/New_York",
    targetLang: "en_US.UTF-8",
    targetLcAll: "en_US.UTF-8",
  };

  it("成功流程：备份 + 3 个 setx + summary", async () => {
    mockedCreateBackup.mockReturnValue({
      timestamp: "2024-01-01T00:00:00Z",
      previous: { TZ: null, LANG: null, LC_ALL: null },
    });

    const onEvent = collectEvents();
    await persistOnFlow(opts, onEvent);

    // 事件序列：backup-start, backup-ok, tz-start, tz-ok, lang-start, lang-ok, lc-start, lc-ok, summary
    const types = events.map(e => e.type);
    expect(types).toEqual([
      "step-start", "step-ok",   // backup
      "step-start", "step-ok",   // tz
      "step-start", "step-ok",   // lang
      "step-start", "step-ok",   // lc
      "summary",
    ]);

    // summary 验证
    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.ok).toBe(3);
    expect(summary.fail).toBe(0);
    expect(summary.rolledBack).toBe(false);

    // step-start 应携带 old→new 值
    const tzStart = events.find(e => e.type === "step-start" && "stepId" in e && e.stepId === "tz") as Extract<StreamEvent, { type: "step-start" }>;
    expect(tzStart.oldValue).toBe("(未设置)");
    expect(tzStart.newValue).toBe("America/New_York");
  });

  it("失败流程：LANG 失败 → 回滚 TZ → summary rolledBack", async () => {
    mockedCreateBackup.mockReturnValue({
      timestamp: "2024-01-01T00:00:00Z",
      previous: { TZ: null, LANG: null, LC_ALL: null },
    });

    // TZ 成功，LANG 失败
    mockedSetEnvVar.mockImplementation((key: string) => {
      if (key === "LANG") throw new Error("setx 退出码 1: 拒绝访问");
    });

    const onEvent = collectEvents();
    await persistOnFlow(opts, onEvent);

    const types = events.map(e => e.type);
    // backup(ok) → tz-start → tz-ok → lang-start → lang-fail → rollback-tz-start → rollback-tz-ok → summary
    expect(types).toEqual([
      "step-start", "step-ok",   // backup
      "step-start", "step-ok",   // tz
      "step-start", "step-fail", // lang 失败
      "step-start", "step-ok",   // rollback tz
      "summary",
    ]);

    // 回滚步骤验证
    const rollbackStart = events.find((e): e is Extract<StreamEvent, { type: "step-start" }> =>
      e.type === "step-start" && (e as any).stepId === "rollback-TZ"
    );
    expect(rollbackStart).toBeDefined();
    expect(rollbackStart!.rollback).toBe(true);
    expect(rollbackStart!.name).toBe("回滚 TZ");

    // summary 验证
    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.ok).toBe(1); // TZ 成功
    expect(summary.fail).toBe(1); // LANG 失败
    expect(summary.rolledBack).toBe(true);
  });

  it("回滚中途失败：summary 不再报告 rolledBack=true，且 fatal", async () => {
    mockedCreateBackup.mockReturnValue({
      timestamp: "2024-01-01T00:00:00Z",
      previous: { TZ: null, LANG: null, LC_ALL: null },
    });

    // TZ、LANG 成功，LC_ALL 失败 → 触发回滚
    mockedSetEnvVar.mockImplementation((key: string) => {
      if (key === "LC_ALL") throw new Error("setx 退出码 1: 拒绝访问");
    });
    // 回滚 TZ 时 deleteEnvVar 失败
    mockedDeleteEnvVar.mockImplementation((key: string) => {
      if (key === "TZ") throw new Error("setx 删除失败: 拒绝访问");
    });

    const onEvent = collectEvents();
    await persistOnFlow(opts, onEvent);

    // 回滚 TZ 失败后仍继续尝试回滚 LANG
    const rollbackEvents = events.filter(
      (e): e is Extract<StreamEvent, { type: "step-start" | "step-fail" | "step-ok" }> =>
        (e.type === "step-start" || e.type === "step-fail" || e.type === "step-ok") &&
        Boolean((e as any).rollback),
    );
    const rollbackIds = rollbackEvents.map(e => `${e.type}:${(e as any).stepId}`);
    expect(rollbackIds).toEqual([
      "step-start:rollback-TZ",
      "step-fail:rollback-TZ",
      "step-start:rollback-LANG",
      "step-ok:rollback-LANG",
    ]);

    // summary 验证：不得报告 rolledBack=true，且标记 fatal
    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.ok).toBe(2); // TZ、LANG 曾成功
    expect(summary.fail).toBe(1); // LC_ALL 失败
    expect(summary.rolledBack).toBe(false);
    expect(summary.fatal).toBe(true);
  });

  it("备份失败：fatal summary", async () => {
    mockedCreateBackup.mockImplementation(() => { throw new Error("磁盘满"); });

    const onEvent = collectEvents();
    await persistOnFlow(opts, onEvent);

    const types = events.map(e => e.type);
    expect(types).toEqual(["step-start", "step-fail", "summary"]);

    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.fatal).toBe(true);
  });
});

describe("persistOffFlow", () => {
  it("成功流程：逐键恢复 + 删备份", async () => {
    mockedGetPersistStatus.mockReturnValue({
      enabled: true,
      backup: {
        timestamp: "2024-01-01T00:00:00Z",
        previous: { TZ: "Asia/Shanghai", LANG: "zh_CN.UTF-8", LC_ALL: null },
      },
      current: { TZ: "America/New_York", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
    });
    mockedGetEnvVar.mockImplementation((key: string) => {
      const vals: Record<string, string> = { TZ: "America/New_York", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
      return vals[key] ?? null;
    });

    const onEvent = collectEvents();
    await persistOffFlow(onEvent);

    // 3 个恢复步骤 + 删备份 + summary
    const starts = events.filter(e => e.type === "step-start");
    expect(starts.length).toBe(4); // TZ, LANG, LC_ALL, delete-backup

    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.ok).toBe(4);
    expect(summary.fail).toBe(0);
    expect(summary.rolledBack).toBe(false);
  });

  it("未开启：fatal summary", async () => {
    mockedGetPersistStatus.mockReturnValue({
      enabled: false,
      backup: null,
      current: {},
    });

    const onEvent = collectEvents();
    await persistOffFlow(onEvent);

    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.fatal).toBe(true);
    expect(summary.ok).toBe(0);
    expect(summary.fail).toBe(1);
  });
});
