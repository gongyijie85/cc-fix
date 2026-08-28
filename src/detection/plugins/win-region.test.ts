// Windows 区域格式检测插件测试

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import { winRegionPlugin } from "./win-region.js";

function regOutput(locale: string): string {
  return `\nHKEY_CURRENT_USER\\Control Panel\\International\n    LocaleName    REG_SZ    ${locale}\n`;
}

function mockRegSuccess(locale: string): void {
  mockExecFile.mockImplementation(
    (_file: string, _args: string[], _options: unknown, callback: (err: Error | null, stdout: string) => void) => {
      callback(null, regOutput(locale));
    }
  );
}

describe("winRegionPlugin", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("returns high risk for zh-CN locale", async () => {
    mockRegSuccess("zh-CN");

    const result = await winRegionPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.id).toBe("win-region");
    expect(result.risk).toBe("high");
    expect(result.score).toBe(1);
    expect(result.contribution).toBe(4);
  });

  it("returns high risk for other zh variants", async () => {
    mockRegSuccess("zh-TW");

    const result = await winRegionPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.risk).toBe("high");
  });

  it("returns low risk for en-US locale", async () => {
    mockRegSuccess("en-US");

    const result = await winRegionPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
  });

  it("returns medium risk for unknown locale", async () => {
    mockRegSuccess("fr-CA");

    const result = await winRegionPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.risk).toBe("medium");
    expect(result.contribution).toBe(2);
  });

  it("returns low risk when registry query fails", async () => {
    mockExecFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (err: Error | null, stdout: string) => void) => {
        callback(new Error("reg not found"), "");
      }
    );

    const result = await winRegionPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
    expect(result.value).toBe("(无法读取)");
  });
});
