// 代理环境检测插件测试

import { describe, it, expect, afterEach } from "vitest";
import { proxyPlugin } from "./proxy.js";

describe("proxyPlugin", () => {
  const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of proxyKeys) {
      if (saved[key] !== undefined) {
        process.env[key] = saved[key];
      } else {
        delete process.env[key];
      }
      delete saved[key];
    }
  });

  it("returns low risk with zero contribution when no proxy env is set", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const result = await proxyPlugin.run({ targetTimezone: "America/New_York", targetLang: "en" });
    expect(result.id).toBe("proxy-env");
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
    expect(result.value).toContain("未配置");
  });

  it("returns low risk when HTTP_PROXY is set", async () => {
    for (const key of proxyKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.HTTP_PROXY = "http://127.0.0.1:7890";
    const result = await proxyPlugin.run({ targetTimezone: "America/New_York", targetLang: "en" });
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
    expect(result.value).toContain("HTTP_PROXY");
  });
});
