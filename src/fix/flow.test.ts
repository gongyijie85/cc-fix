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
  getSystemTimezone: vi.fn(),
  setSystemTimezone: vi.fn(),
  patchBackupSystemTimezone: vi.fn(),
  patchBackupBrowserPolicies: vi.fn(),
}));

// Mock 浏览器策略模块（保留纯函数与常量，替换注册表副作用）
vi.mock("../platform/browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/browser.js")>();
  return {
    ...actual,
    getPolicy: vi.fn(),
    setPolicy: vi.fn(),
    deletePolicy: vi.fn(),
    snapshotPolicies: vi.fn(),
    detectRunningBrowsers: vi.fn(),
  };
});

import { persistOnFlow, persistOffFlow } from "./flow.js";
import {
  createBackup,
  setEnvVar,
  deleteEnvVar,
  getEnvVar,
  getPersistStatus,
  getSystemTimezone,
  setSystemTimezone,
  patchBackupSystemTimezone,
  patchBackupBrowserPolicies,
} from "../platform/windows.js";
import {
  getPolicy,
  setPolicy,
  deletePolicy,
  snapshotPolicies,
  detectRunningBrowsers,
} from "../platform/browser.js";

const mockedCreateBackup = vi.mocked(createBackup);
const mockedSetEnvVar = vi.mocked(setEnvVar);
const mockedDeleteEnvVar = vi.mocked(deleteEnvVar);
const mockedGetEnvVar = vi.mocked(getEnvVar);
const mockedGetPersistStatus = vi.mocked(getPersistStatus);
const mockedGetSystemTimezone = vi.mocked(getSystemTimezone);
const mockedSetSystemTimezone = vi.mocked(setSystemTimezone);
const mockedPatchBackupSystemTimezone = vi.mocked(patchBackupSystemTimezone);
const mockedPatchBackupBrowserPolicies = vi.mocked(patchBackupBrowserPolicies);
const mockedGetPolicy = vi.mocked(getPolicy);
const mockedSetPolicy = vi.mocked(setPolicy);
const mockedDeletePolicy = vi.mocked(deletePolicy);
const mockedSnapshotPolicies = vi.mocked(snapshotPolicies);
const mockedDetectRunningBrowsers = vi.mocked(detectRunningBrowsers);

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
  // 默认：系统时区为中国标准时间，tzutil 写入成功
  mockedGetSystemTimezone.mockReturnValue("China Standard Time");
  mockedSetSystemTimezone.mockImplementation(() => {});
  mockedPatchBackupSystemTimezone.mockImplementation(() => {});
  mockedPatchBackupBrowserPolicies.mockImplementation(() => {});
  // 默认：浏览器策略全部不存在，写入成功
  mockedGetPolicy.mockReturnValue(null);
  mockedSetPolicy.mockImplementation(() => {});
  mockedDeletePolicy.mockImplementation(() => {});
  mockedSnapshotPolicies.mockReturnValue({
    "chrome/AcceptLanguage": null,
    "chrome/DefaultWebRtcIPHandlingPolicy": null,
    "edge/AcceptLanguage": null,
    "edge/DefaultWebRtcIPHandlingPolicy": null,
  });
  // 默认：Chrome 正在运行（重启提示加强显示的依据）
  mockedDetectRunningBrowsers.mockReturnValue(["chrome"]);
});

describe("persistOnFlow", () => {
  const opts = {
    regionCode: "us",
    targetTimezone: "America/New_York",
    targetWinTimezone: "Eastern Standard Time",
    targetLang: "en_US.UTF-8",
    targetLcAll: "en_US.UTF-8",
  };

  it("成功流程：备份 + 3 个 setx + 浏览器策略 + 切换系统时区 + summary", async () => {
    mockedCreateBackup.mockReturnValue({
      timestamp: "2024-01-01T00:00:00Z",
      previous: { TZ: null, LANG: null, LC_ALL: null },
      previousSystemTimezone: "China Standard Time",
    });

    const onEvent = collectEvents();
    await persistOnFlow(opts, onEvent);

    const types = events.map(e => e.type);
    expect(types).toEqual([
      "step-start", "step-ok",   // backup
      "step-start", "step-ok",   // tz
      "step-start", "step-ok",   // lang
      "step-start", "step-ok",   // lc
      "step-start", "step-ok",   // browser-policy
      "browser-hint",            // 重启生效提示
      "step-start", "step-ok",   // sys-tz
      "summary",
    ]);

    // summary 验证（3 个环境变量 + 1 个浏览器策略 + 1 个系统时区）
    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.ok).toBe(5);
    expect(summary.fail).toBe(0);
    expect(summary.rolledBack).toBe(false);

    // 四个槽位均写入规范值（AcceptLanguage 从 targetLang 推导）
    expect(mockedSetPolicy).toHaveBeenCalledTimes(4);
    expect(mockedSetPolicy).toHaveBeenCalledWith("chrome", "AcceptLanguage", "en-US");
    expect(mockedSetPolicy).toHaveBeenCalledWith("edge", "AcceptLanguage", "en-US");
    expect(mockedSetPolicy).toHaveBeenCalledWith("chrome", "DefaultWebRtcIPHandlingPolicy", "disable_non_proxied_udp");
    expect(mockedSetPolicy).toHaveBeenCalledWith("edge", "DefaultWebRtcIPHandlingPolicy", "disable_non_proxied_udp");

    // sys-tz 步骤携带旧→新值
    const sysTzStart = events.find(e => e.type === "step-start" && "stepId" in e && e.stepId === "sys-tz") as Extract<StreamEvent, { type: "step-start" }>;
    expect(sysTzStart.oldValue).toBe("China Standard Time");
    expect(sysTzStart.newValue).toBe("Eastern Standard Time");
    expect(mockedSetSystemTimezone).toHaveBeenCalledWith("Eastern Standard Time");

    // 策略写入成功后推送重启提示，携带运行中浏览器
    const hint = events.find(e => e.type === "browser-hint") as Extract<StreamEvent, { type: "browser-hint" }>;
    expect(hint.running).toEqual(["chrome"]);
  });

  it("系统时区已是目标值：跳过 sys-tz 步骤，浏览器策略仍写入", async () => {
    mockedCreateBackup.mockReturnValue({
      timestamp: "2024-01-01T00:00:00Z",
      previous: { TZ: null, LANG: null, LC_ALL: null },
      previousSystemTimezone: "China Standard Time",
    });
    mockedGetSystemTimezone.mockReturnValue("Eastern Standard Time");

    const onEvent = collectEvents();
    await persistOnFlow(opts, onEvent);

    const types = events.map(e => e.type);
    expect(types).toEqual([
      "step-start", "step-ok",   // backup
      "step-start", "step-ok",   // tz
      "step-start", "step-ok",   // lang
      "step-start", "step-ok",   // lc
      "step-start", "step-ok",   // browser-policy
      "browser-hint",            // 重启生效提示
      "summary",
    ]);
    expect(mockedSetSystemTimezone).not.toHaveBeenCalled();

    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.ok).toBe(4);
  });

  it("旧备份缺失系统时区与策略快照字段：补写当前值", async () => {
    mockedCreateBackup.mockReturnValue({
      timestamp: "2024-01-01T00:00:00Z",
      previous: { TZ: null, LANG: null, LC_ALL: null },
    });

    const onEvent = collectEvents();
    await persistOnFlow(opts, onEvent);

    expect(mockedPatchBackupSystemTimezone).toHaveBeenCalledWith("China Standard Time");
    expect(mockedSnapshotPolicies).toHaveBeenCalled();
    expect(mockedPatchBackupBrowserPolicies).toHaveBeenCalledWith({
      "chrome/AcceptLanguage": null,
      "chrome/DefaultWebRtcIPHandlingPolicy": null,
      "edge/AcceptLanguage": null,
      "edge/DefaultWebRtcIPHandlingPolicy": null,
    });
  });

  it("快照中已是规范值的槽位：跳过写入，无 browser-policy 步骤", async () => {
    const canonical = {
      "chrome/AcceptLanguage": "en-US",
      "chrome/DefaultWebRtcIPHandlingPolicy": "disable_non_proxied_udp",
      "edge/AcceptLanguage": "en-US",
      "edge/DefaultWebRtcIPHandlingPolicy": "disable_non_proxied_udp",
    };
    mockedCreateBackup.mockReturnValue({
      timestamp: "2024-01-01T00:00:00Z",
      previous: { TZ: null, LANG: null, LC_ALL: null },
      previousSystemTimezone: "China Standard Time",
      previousBrowserPolicies: canonical,
    });

    const onEvent = collectEvents();
    await persistOnFlow(opts, onEvent);

    expect(events.some(e => e.type === "step-start" && "stepId" in e && e.stepId === "browser-policy")).toBe(false);
    expect(mockedSetPolicy).not.toHaveBeenCalled();
    // 未写入策略则无重启提示
    expect(events.some(e => e.type === "browser-hint")).toBe(false);

    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.ok).toBe(4); // 3 环境变量 + 系统时区
  });

  it("浏览器策略写入失败：还原已写策略 + 回滚环境变量", async () => {
    mockedCreateBackup.mockReturnValue({
      timestamp: "2024-01-01T00:00:00Z",
      previous: { TZ: null, LANG: null, LC_ALL: null },
      previousSystemTimezone: "China Standard Time",
      previousBrowserPolicies: {
        "chrome/AcceptLanguage": "zh-CN",
        "chrome/DefaultWebRtcIPHandlingPolicy": null,
        "edge/AcceptLanguage": null,
        "edge/DefaultWebRtcIPHandlingPolicy": null,
      },
    });
    // edge/AcceptLanguage 写入失败（此前 chrome 两槽位已写入）
    mockedSetPolicy.mockImplementation((browser, name) => {
      if (browser === "edge" && name === "AcceptLanguage") throw new Error("reg 磁盘故障");
    });

    const onEvent = collectEvents();
    await persistOnFlow(opts, onEvent);

    const browserFail = events.find(e => e.type === "step-fail" && "stepId" in e && e.stepId === "browser-policy");
    expect(browserFail).toBeDefined();

    // 已写入的两个 chrome 槽位按快照还原（zh-CN 写回，WebRTC 删除）
    expect(mockedSetPolicy).toHaveBeenCalledWith("chrome", "AcceptLanguage", "zh-CN");
    expect(mockedDeletePolicy).toHaveBeenCalledWith("chrome", "DefaultWebRtcIPHandlingPolicy");

    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.fail).toBe(1);
    expect(summary.rolledBack).toBe(true);
  });

  it("浏览器策略写入被拒（Access is denied）：降级不阻断，继续系统时区", async () => {
    mockedCreateBackup.mockReturnValue({
      timestamp: "2024-01-01T00:00:00Z",
      previous: { TZ: null, LANG: null, LC_ALL: null },
      previousSystemTimezone: "China Standard Time",
    });
    mockedSetPolicy.mockImplementation(() => {
      throw new Error("Command failed: reg add ... ERROR: Access is denied.");
    });

    const onEvent = collectEvents();
    await persistOnFlow(opts, onEvent);

    // browser-policy 失败但流程继续：sys-tz 仍执行，不回滚环境变量
    const browserFail = events.find(e => e.type === "step-fail" && "stepId" in e && e.stepId === "browser-policy") as Extract<StreamEvent, { type: "step-fail" }>;
    expect(browserFail.error).toContain("管理员权限");
    expect(mockedSetSystemTimezone).toHaveBeenCalledWith("Eastern Standard Time");
    // 未触发环境变量回滚（无 rollback-* 步骤）
    expect(events.some(e => e.type === "step-start" && "stepId" in e && String(e.stepId).startsWith("rollback-"))).toBe(false);
    // 策略未写入成功：不推送重启提示
    expect(events.some(e => e.type === "browser-hint")).toBe(false);

    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.ok).toBe(4); // 3 环境变量 + 系统时区
    expect(summary.fail).toBe(1);
    expect(summary.fatal).toBeUndefined();
  });

  it("系统时区切换失败：还原浏览器策略 + 回滚已修改的环境变量", async () => {
    mockedCreateBackup.mockReturnValue({
      timestamp: "2024-01-01T00:00:00Z",
      previous: { TZ: null, LANG: null, LC_ALL: null },
      previousSystemTimezone: "China Standard Time",
    });
    mockedSetSystemTimezone.mockImplementation(() => {
      throw new Error("tzutil 退出码 1: 拒绝访问");
    });

    const onEvent = collectEvents();
    await persistOnFlow(opts, onEvent);

    const types = events.map(e => e.type);
    expect(types).toEqual([
      "step-start", "step-ok",   // backup
      "step-start", "step-ok",   // tz
      "step-start", "step-ok",   // lang
      "step-start", "step-ok",   // lc
      "step-start", "step-ok",   // browser-policy
      "browser-hint",            // 重启生效提示
      "step-start", "step-fail", // sys-tz 失败
      "step-start", "step-ok",   // rollback-policy ×4
      "step-start", "step-ok",
      "step-start", "step-ok",
      "step-start", "step-ok",
      "step-start", "step-ok",   // rollback TZ
      "step-start", "step-ok",   // rollback LANG
      "step-start", "step-ok",   // rollback LC_ALL
      "summary",
    ]);

    // 策略还原步骤带 rollback 标记
    const rollbackPolicyStart = events.find(
      (e): e is Extract<StreamEvent, { type: "step-start" }> =>
        e.type === "step-start" && "stepId" in e && String(e.stepId).startsWith("rollback-policy-"),
    );
    expect(rollbackPolicyStart?.rollback).toBe(true);

    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.ok).toBe(3);
    expect(summary.fail).toBe(1);
    expect(summary.rolledBack).toBe(true);
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

  it("备份含系统时区：恢复环境变量 + 恢复系统时区 + 删备份", async () => {
    mockedGetPersistStatus.mockReturnValue({
      enabled: true,
      backup: {
        timestamp: "2024-01-01T00:00:00Z",
        previous: { TZ: null, LANG: null, LC_ALL: null },
        previousSystemTimezone: "China Standard Time",
      },
      current: { TZ: "America/New_York", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
    });
    mockedGetEnvVar.mockImplementation((key: string) => {
      const vals: Record<string, string> = { TZ: "America/New_York", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
      return vals[key] ?? null;
    });
    mockedGetSystemTimezone.mockReturnValue("Eastern Standard Time");

    const onEvent = collectEvents();
    await persistOffFlow(onEvent);

    // 3 个恢复步骤 + 恢复系统时区 + 删备份 + summary
    const starts = events.filter(e => e.type === "step-start");
    expect(starts.length).toBe(5);

    const sysTzStart = events.find(e => e.type === "step-start" && "stepId" in e && e.stepId === "restore-sys-tz") as Extract<StreamEvent, { type: "step-start" }>;
    expect(sysTzStart.oldValue).toBe("Eastern Standard Time");
    expect(sysTzStart.newValue).toBe("China Standard Time");
    expect(mockedSetSystemTimezone).toHaveBeenCalledWith("China Standard Time");

    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.ok).toBe(5);
    expect(summary.fail).toBe(0);
  });

  it("降级状态 off：策略当前值即快照原值，跳过还原直接删备份", async () => {
    const snapshot = {
      "chrome/AcceptLanguage": null,
      "chrome/DefaultWebRtcIPHandlingPolicy": "disable_non_proxied",
      "edge/AcceptLanguage": null,
      "edge/DefaultWebRtcIPHandlingPolicy": null,
    };
    mockedGetPersistStatus.mockReturnValue({
      enabled: true,
      backup: {
        timestamp: "2024-01-01T00:00:00Z",
        previous: { TZ: null },
        previousBrowserPolicies: snapshot,
      },
      current: { TZ: "America/New_York" },
    });
    mockedGetEnvVar.mockReturnValue("America/New_York");
    // 当前注册表状态与快照一致（策略从未被写入）
    mockedGetPolicy.mockImplementation((browser, name) => {
      return snapshot[`${browser}/${name}`] ?? null;
    });

    const onEvent = collectEvents();
    await persistOffFlow(onEvent);

    // 无还原策略步骤，也无任何策略写入/删除
    expect(events.some(e => e.type === "step-start" && "stepId" in e && String(e.stepId).startsWith("restore-browser-policy"))).toBe(false);
    expect(mockedSetPolicy).not.toHaveBeenCalled();
    expect(mockedDeletePolicy).not.toHaveBeenCalled();

    // 还原 TZ + 删备份
    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.ok).toBe(2);
    expect(summary.fail).toBe(0);
  });

  it("备份含策略快照：逐浏览器还原（null 删除、有值写回）+ 删备份", async () => {
    mockedGetPersistStatus.mockReturnValue({
      enabled: true,
      backup: {
        timestamp: "2024-01-01T00:00:00Z",
        previous: { TZ: null },
        previousBrowserPolicies: {
          "chrome/AcceptLanguage": null,
          "chrome/DefaultWebRtcIPHandlingPolicy": "disable_non_proxied",
          "edge/AcceptLanguage": null,
          "edge/DefaultWebRtcIPHandlingPolicy": null,
        },
      },
      current: { TZ: "America/New_York" },
    });
    mockedGetEnvVar.mockReturnValue("America/New_York");
    mockedGetPolicy.mockReturnValue("en-US");

    const onEvent = collectEvents();
    await persistOffFlow(onEvent);

    // 还原 TZ + chrome 策略 + edge 策略 + 删备份（逐浏览器各一步，不跨浏览器合并）
    const starts = events.filter(e => e.type === "step-start");
    expect(starts.length).toBe(4);
    const chromeStart = events.find(e => e.type === "step-start" && "stepId" in e && e.stepId === "restore-browser-policy-chrome") as Extract<StreamEvent, { type: "step-start" }>;
    const edgeStart = events.find(e => e.type === "step-start" && "stepId" in e && e.stepId === "restore-browser-policy-edge") as Extract<StreamEvent, { type: "step-start" }>;
    expect(chromeStart).toBeDefined();
    expect(edgeStart).toBeDefined();
    // 每步 oldValue/newValue 只含本浏览器的两个槽位
    expect(chromeStart.oldValue!.split(", ")).toHaveLength(2);
    expect(edgeStart.oldValue!.split(", ")).toHaveLength(2);

    // chrome：null → 删除；非法旧值 → 写回原值
    expect(mockedDeletePolicy).toHaveBeenCalledWith("chrome", "AcceptLanguage");
    expect(mockedSetPolicy).toHaveBeenCalledWith("chrome", "DefaultWebRtcIPHandlingPolicy", "disable_non_proxied");
    // edge：两槽位均删除
    expect(mockedDeletePolicy).toHaveBeenCalledWith("edge", "AcceptLanguage");
    expect(mockedDeletePolicy).toHaveBeenCalledWith("edge", "DefaultWebRtcIPHandlingPolicy");
    // 策略写入总次数：chrome WebRTC 写回 + edge 两次删除不算写入
    expect(mockedSetPolicy).toHaveBeenCalledTimes(1);

    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.ok).toBe(4);
    expect(summary.fail).toBe(0);
  });

  it("浏览器策略还原失败：fatal 且不删备份", async () => {
    mockedGetPersistStatus.mockReturnValue({
      enabled: true,
      backup: {
        timestamp: "2024-01-01T00:00:00Z",
        previous: { TZ: null },
        previousBrowserPolicies: {
          "chrome/AcceptLanguage": "zh-CN",
          "chrome/DefaultWebRtcIPHandlingPolicy": null,
          "edge/AcceptLanguage": null,
          "edge/DefaultWebRtcIPHandlingPolicy": null,
        },
      },
      current: { TZ: "America/New_York" },
    });
    mockedGetEnvVar.mockReturnValue("America/New_York");
    mockedSetPolicy.mockImplementation(() => {
      throw new Error("reg 拒绝访问");
    });

    const onEvent = collectEvents();
    await persistOffFlow(onEvent);

    const types = events.map(e => e.type);
    // 还原 TZ(ok) → restore-browser-policy-chrome(start/fail) → summary；不进入删备份
    expect(types).toEqual([
      "step-start", "step-ok",
      "step-start", "step-fail",
      "summary",
    ]);

    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.fatal).toBe(true);
    expect(summary.fail).toBe(1);
  });

  it("系统时区恢复失败：fatal 且不删备份", async () => {
    mockedGetPersistStatus.mockReturnValue({
      enabled: true,
      backup: {
        timestamp: "2024-01-01T00:00:00Z",
        previous: { TZ: null },
        previousSystemTimezone: "China Standard Time",
      },
      current: { TZ: "America/New_York" },
    });
    mockedGetEnvVar.mockReturnValue("America/New_York");
    mockedGetSystemTimezone.mockReturnValue("Eastern Standard Time");
    mockedSetSystemTimezone.mockImplementation(() => {
      throw new Error("tzutil 退出码 1: 拒绝访问");
    });

    const onEvent = collectEvents();
    await persistOffFlow(onEvent);

    const types = events.map(e => e.type);
    // 恢复 TZ(ok) → restore-sys-tz(start/fail) → summary；不进入删备份步骤
    expect(types).toEqual([
      "step-start", "step-ok",
      "step-start", "step-fail",
      "summary",
    ]);

    const summary = events.find(e => e.type === "summary") as Extract<StreamEvent, { type: "summary" }>;
    expect(summary.fatal).toBe(true);
    expect(summary.fail).toBe(1);
  });
});
