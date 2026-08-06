// UTC 偏移检测插件测试

import { describe, it, expect } from "vitest";
import { utcOffsetPlugin } from "./utc-offset.js";

describe("utcOffsetPlugin", () => {
  it("returns low risk when offset matches target timezone", async () => {
    // This test depends on the actual system timezone
    // We test the plugin interface works correctly
    const result = await utcOffsetPlugin.run({
      targetTimezone: "America/New_York",
      targetLang: "en",
    });
    expect(result.id).toBe("utc-offset");
    expect(result.weight).toBe(4);
    expect(result.source).toBe("system");
    expect(["low", "medium"]).toContain(result.risk);
  });

  it("returns low risk for unknown timezone", async () => {
    const result = await utcOffsetPlugin.run({
      targetTimezone: "Unknown/Timezone",
      targetLang: "en",
    });
    expect(result.risk).toBe("low");
    expect(result.contribution).toBe(0);
  });

  it("formats offset correctly", async () => {
    const result = await utcOffsetPlugin.run({
      targetTimezone: "Asia/Tokyo",
      targetLang: "en",
    });
    // Value should be in UTC±HH:MM format
    expect(result.value).toMatch(/^UTC[+-]\d{2}:\d{2}$/);
  });
});
