// 浏览器策略检测侧 I/O 测试 — 槽 id 为唯一规范词汇（ADR-0011）

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { BROWSER_LABELS, detectRunningBrowsers, getPolicy } from "./browser.js";

const mockedExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("BROWSER_LABELS", () => {
  it("covers both managed browsers", () => {
    expect(BROWSER_LABELS).toEqual({ chrome: "Chrome", edge: "Edge" });
  });
});

describe("getPolicy", () => {
  it("reg query 命中 REG_SZ：返回去除首尾空白的值（按槽 id 从目录查路径）", () => {
    mockedExecSync.mockReturnValue(
      "HKEY_CURRENT_USER\\Software\\Policies\\Google\\Chrome\n    AcceptLanguage    REG_SZ    en-US\n",
    );
    expect(getPolicy("chrome.accept_language")).toBe("en-US");
    const query = mockedExecSync.mock.calls.at(-1)?.[0];
    expect(String(query)).toContain("HKCU\\Software\\Policies\\Google\\Chrome");
    expect(String(query)).toContain("AcceptLanguage");
  });

  it("reg query 失败（键不存在）：返回 null", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("ERROR: The system was unable to find the specified registry key or value.");
    });
    expect(getPolicy("edge.application_locale")).toBeNull();
  });

  it("目录外的槽 id 直接拒绝", () => {
    expect(() => getPolicy("chrome.anything" as never)).toThrow("Unmanaged browser policy slot");
  });
});
