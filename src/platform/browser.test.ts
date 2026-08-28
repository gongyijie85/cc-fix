// 浏览器策略检测侧 I/O 测试 — 槽 id 为唯一规范词汇（ADR-0011）
// issue #61：检测改异步 execFile（不再 execSync 阻塞事件循环）。

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { BROWSER_LABELS, detectRunningBrowsers, readPolicyValues } from "./browser.js";

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

describe("readPolicyValues", () => {
  it("一次 reg query 解析全部 REG_SZ 值并按 valueName 索引", async () => {
    mockStdout(
      "HKEY_CURRENT_USER\\Software\\Policies\\Google\\Chrome\n" +
      "    AcceptLanguage    REG_SZ    en-US\n" +
      "    DefaultWebRtcIPHandlingPolicy    REG_SZ    disable_non_proxied_udp\n",
    );
    const values = await readPolicyValues("chrome");
    expect(values.AcceptLanguage).toBe("en-US");
    expect(values.DefaultWebRtcIPHandlingPolicy).toBe("disable_non_proxied_udp");
    // 槽目录中存在的值未出现在输出时记 null（缺失 ≠ 异常形态）
    expect(values.ApplicationLocaleValue).toBeNull();
    const [command, args] = mockedExecFile.mock.calls.at(-1)!;
    expect(command).toBe("reg");
    expect(args).toEqual(["query", "HKCU\\Software\\Policies\\Google\\Chrome"]);
  });

  it("键不存在（reg query 失败）：全部槽位为 null", async () => {
    mockFailure("ERROR: The system was unable to find the specified registry key or value.");
    const values = await readPolicyValues("edge");
    expect(values).toEqual({ AcceptLanguage: null, DefaultWebRtcIPHandlingPolicy: null, ApplicationLocaleValue: null });
  });

  it("忽略非 REG_SZ 的行", async () => {
    mockStdout(
      "HKEY_CURRENT_USER\\Software\\Policies\\Google\\Chrome\n" +
      "    (Default)    REG_SZ    (value not set)\n" +
      "    AcceptLanguage    REG_SZ    en-US\n",
    );
    const values = await readPolicyValues("chrome");
    expect(values.AcceptLanguage).toBe("en-US");
    expect(values.ApplicationLocaleValue).toBeNull();
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
