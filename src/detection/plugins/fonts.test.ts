// 系统字体检测插件测试

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockReaddir } = vi.hoisted(() => ({ mockReaddir: vi.fn() }));

vi.mock("node:fs", () => ({
  readdirSync: mockReaddir,
}));

import { fontsPlugin } from "./fonts.js";

describe("fontsPlugin", () => {
  beforeEach(() => {
    mockReaddir.mockReset();
  });

  it("returns high risk when Chinese fonts are found", async () => {
    mockReaddir.mockReturnValue(["arial.ttf", "msyh.ttc", "simsun.ttc", "times.ttf"]);

    const result = await fontsPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.id).toBe("fonts");
    expect(result.risk).toBe("high");
    expect(result.contribution).toBe(10);
    expect(result.value).toContain("中文字体");
  });

  it("matches font names case-insensitively", async () => {
    mockReaddir.mockReturnValue(["MSYH.TTC"]);

    const result = await fontsPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.risk).toBe("high");
  });

  it("returns low risk when no Chinese fonts exist", async () => {
    mockReaddir.mockReturnValue(["arial.ttf", "calibri.ttf", "times.ttf"]);

    const result = await fontsPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
    expect(result.value).toBe("未发现中文字体");
  });

  it("returns low risk when fonts directory is unreadable", async () => {
    mockReaddir.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = await fontsPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
  });
});
