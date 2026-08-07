// 浏览器策略模块测试 — 纯函数与快照/还原语义

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import {
  acceptLanguageFromLang,
  targetPolicies,
  slotKey,
  getPolicy,
  snapshotPolicies,
  restorePolicies,
  detectRunningBrowsers,
  POLICY_SLOTS,
} from "./browser.js";

const mockedExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("acceptLanguageFromLang", () => {
  it("en_US.UTF-8 → en-US", () => {
    expect(acceptLanguageFromLang("en_US.UTF-8")).toBe("en-US");
  });

  it("ja_JP.UTF-8 → ja-JP", () => {
    expect(acceptLanguageFromLang("ja_JP.UTF-8")).toBe("ja-JP");
  });

  it("无编码后缀同样可推导", () => {
    expect(acceptLanguageFromLang("en_GB")).toBe("en-GB");
  });
});

describe("targetPolicies", () => {
  it("六个槽位均取规范值，AcceptLanguage/ApplicationLocale 跟随地区", () => {
    const targets = targetPolicies("en_SG.UTF-8");
    expect(targets).toEqual({
      "chrome/AcceptLanguage": "en-SG,en",
      "chrome/DefaultWebRtcIPHandlingPolicy": "disable_non_proxied_udp",
      "chrome/ApplicationLocaleValue": "en-SG",
      "edge/AcceptLanguage": "en-SG,en",
      "edge/DefaultWebRtcIPHandlingPolicy": "disable_non_proxied_udp",
      "edge/ApplicationLocaleValue": "en-SG",
    });
  });
});

describe("getPolicy", () => {
  it("reg query 命中 REG_SZ：返回去除首尾空白的值", () => {
    mockedExecSync.mockReturnValue(
      "HKEY_CURRENT_USER\\Software\\Policies\\Google\\Chrome\n    AcceptLanguage    REG_SZ    en-US\n",
    );
    expect(getPolicy("chrome", "AcceptLanguage")).toBe("en-US");
  });

  it("reg query 失败（键不存在）：返回 null", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("ERROR: The system was unable to find the specified registry key or value.");
    });
    expect(getPolicy("edge", "AcceptLanguage")).toBeNull();
  });
});

describe("snapshotPolicies / restorePolicies", () => {
  it("snapshot 覆盖全部六个槽位", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    const snapshot = snapshotPolicies();
    expect(Object.keys(snapshot).sort()).toEqual(POLICY_SLOTS.map(slotKey).sort());
    expect(Object.values(snapshot)).toEqual([null, null, null, null, null, null]);
  });

  it("restore：null → reg delete，有值 → reg add", () => {
    mockedExecSync.mockReturnValue("");
    restorePolicies({
      "chrome/AcceptLanguage": null,
      "chrome/DefaultWebRtcIPHandlingPolicy": "disable_non_proxied",
      "chrome/ApplicationLocaleValue": "en-US",
      "edge/AcceptLanguage": "ja-JP",
      "edge/DefaultWebRtcIPHandlingPolicy": null,
      "edge/ApplicationLocaleValue": null,
    });

    const calls = mockedExecSync.mock.calls.map(c => String(c[0]));
    expect(calls.some(c => c.includes("reg delete") && c.includes("Google\\Chrome") && c.includes("AcceptLanguage"))).toBe(true);
    expect(calls.some(c => c.includes("reg add") && c.includes("disable_non_proxied"))).toBe(true);
    expect(calls.some(c => c.includes("reg add") && c.includes("Microsoft\\Edge") && c.includes("ja-JP"))).toBe(true);
    expect(calls.some(c => c.includes("reg add") && c.includes("ApplicationLocaleValue") && c.includes("en-US"))).toBe(true);
  });

  it("restore：快照缺失的槽位跳过", () => {
    mockedExecSync.mockReturnValue("");
    restorePolicies({ "chrome/AcceptLanguage": null });
    // 1 次 delete，无其它调用
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });
});

describe("detectRunningBrowsers", () => {
  it("逐个查询 chrome/msedge：返回去重后的浏览器列表", () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes("chrome.exe")) {
        return "chrome.exe                   12345 Console     1    1,234 K\n" +
          "chrome.exe                   12346 Console     1      567 K\n";
      }
      if (c.includes("msedge.exe")) {
        return "msedge.exe                   23456 Console     1    2,345 K\n";
      }
      return "";
    });
    expect(detectRunningBrowsers().sort()).toEqual(["chrome", "edge"]);
    // 回归守护：每次查询只带单个 /FI（多个 /FI 为 AND 连接，IMAGENAME 恒假）
    const calls = mockedExecSync.mock.calls.map(c => String(c[0]));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.match(/\/FI/g)?.length).toBe(1);
    }
  });

  it("仅 chrome 运行：返回单项", () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes("chrome.exe")) return "chrome.exe 12345 Console 1 1,234 K\n";
      return "INFO: No tasks are running which match the specified criteria.\n";
    });
    expect(detectRunningBrowsers()).toEqual(["chrome"]);
  });

  it("均未运行（INFO 提示行）：返回空数组", () => {
    mockedExecSync.mockReturnValue("INFO: No tasks are running which match the specified criteria.\n");
    expect(detectRunningBrowsers()).toEqual([]);
  });

  it("tasklist 全部异常（如权限问题）：降级为空数组不抛出", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("Access is denied.");
    });
    expect(detectRunningBrowsers()).toEqual([]);
  });

  it("部分探测失败：仍返回另一浏览器的结果", () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes("chrome.exe")) throw new Error("Access is denied.");
      return "msedge.exe 23456 Console 1 2,345 K\n";
    });
    expect(detectRunningBrowsers()).toEqual(["edge"]);
  });
});
