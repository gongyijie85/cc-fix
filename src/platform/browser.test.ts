// 浏览器策略检测侧 I/O 测试 — 槽 id 为唯一规范词汇（ADR-0011）
// issue #61：检测改异步 execFile（不再 execSync 阻塞事件循环）。

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { BROWSER_LABELS, detectRunningBrowsers, getPolicy } from "./browser.js";

const mockedExecFile = vi.mocked(execFile);

/** 让 mock 的 execFile 以成功回调返回 stdout。 */
function mockStdout(stdout: string): void {
  mockedExecFile.mockImplementation((_command, _args, _options, callback) => {
    const cb = callback as (error: Error | null, stdout: string) => void;
    cb(null, stdout);
    return {} as ReturnType<typeof execFile>;
  });
}

/** 让 mock 的 execFile 以失败回调返回。 */
function mockFailure(message: string): void {
  mockedExecFile.mockImplementation((_command, _args, _options, callback) => {
    const cb = callback as (error: Error | null, stdout: string) => void;
    cb(new Error(message), "");
    return {} as ReturnType<typeof execFile>;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("BROWSER_LABELS", () => {
  it("covers both managed browsers", () => {
    expect(BROWSER_LABELS).toEqual({ chrome: "Chrome", edge: "Edge" });
  });
});

describe("getPolicy", () => {
  it("reg query 命中 REG_SZ：返回去除首尾空白的值（按槽 id 从目录查路径）", async () => {
    mockStdout("HKEY_CURRENT_USER\\Software\\Policies\\Google\\Chrome\n    AcceptLanguage    REG_SZ    en-US\n");
    await expect(getPolicy("chrome.accept_language")).resolves.toBe("en-US");
    const [command, args] = mockedExecFile.mock.calls.at(-1)!;
    expect(command).toBe("reg");
    expect(args).toContain("HKCU\\Software\\Policies\\Google\\Chrome");
    expect(args).toContain("AcceptLanguage");
  });

  it("reg query 失败（键不存在）：返回 null", async () => {
    mockFailure("ERROR: The system was unable to find the specified registry key or value.");
    await expect(getPolicy("edge.application_locale")).resolves.toBeNull();
  });

  it("目录外的槽 id 直接拒绝", async () => {
    await expect(getPolicy("chrome.anything" as never)).rejects.toThrow("Unmanaged browser policy slot");
  });
});

describe("detectRunningBrowsers", () => {
  it("一次 tasklist 全量输出，内存匹配多个镜像名（issue #61）", async () => {
    mockStdout(
      "chrome.exe                      1234 Console                    1     45,678 K\n" +
      "msedge.exe                      2345 Console                    1     56,789 K\n" +
      "explorer.exe                    3456 Console                    1     12,345 K\n",
    );
    await expect(detectRunningBrowsers()).resolves.toEqual(["chrome", "edge"]);
    const [command, args] = mockedExecFile.mock.calls.at(-1)!;
    expect(command).toBe("tasklist");
    expect(args).toEqual(["/NH"]);
  });

  it("tasklist 失败降级返回空数组", async () => {
    mockFailure("tasklist failed");
    await expect(detectRunningBrowsers()).resolves.toEqual([]);
  });

  it("无浏览器运行时返回空数组", async () => {
    mockStdout("explorer.exe                      3456 Console                    1     12,345 K\n");
    await expect(detectRunningBrowsers()).resolves.toEqual([]);
  });
});
