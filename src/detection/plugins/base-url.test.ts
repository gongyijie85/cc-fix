// BASE_URL 检测插件测试

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { baseUrlPlugin } from "./base-url.js";

describe("baseUrlPlugin", () => {
  const originalEnv = process.env.ANTHROPIC_BASE_URL;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_BASE_URL = originalEnv;
    } else {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  it("returns low risk when ANTHROPIC_BASE_URL is not set", async () => {
    delete process.env.ANTHROPIC_BASE_URL;
    const result = await baseUrlPlugin.run({ targetTimezone: "America/New_York", targetLang: "en" });
    expect(result.id).toBe("base-url");
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
  });

  it("returns low risk for safe domain", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    const result = await baseUrlPlugin.run({ targetTimezone: "America/New_York", targetLang: "en" });
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
    // #70 决议：value 只输出 hostname
    expect(result.value).toBe("api.anthropic.com");
  });

  it("returns high risk for sensitive domain", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://api.deepseek.com";
    const result = await baseUrlPlugin.run({ targetTimezone: "America/New_York", targetLang: "en" });
    expect(result.risk).toBe("high");
    expect(result.contribution).toBe(8);
    expect(result.value).toBe("api.deepseek.com");
  });

  it("redacts embedded credentials in value (#70)", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://user:secret@api.deepseek.com/v1";
    const result = await baseUrlPlugin.run({ targetTimezone: "America/New_York", targetLang: "en" });
    expect(result.value).toBe("***@api.deepseek.com");
    expect(result.risk).toBe("high");
  });

  it("redacts username-only credentials and unprefixed inputs", async () => {
    process.env.ANTHROPIC_BASE_URL = "proxy-user@example.com";
    const first = await baseUrlPlugin.run({ targetTimezone: "America/New_York", targetLang: "en" });
    expect(first.value).toBe("***@example.com");
    process.env.ANTHROPIC_BASE_URL = "https://user@api.anthropic.com";
    const second = await baseUrlPlugin.run({ targetTimezone: "America/New_York", targetLang: "en" });
    expect(second.value).toBe("***@api.anthropic.com");
  });
});
