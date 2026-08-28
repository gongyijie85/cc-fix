import { describe, expect, it } from "vitest";
import { describeFontStatus } from "../../assets/gui/renderers.js";

describe("font panel view model", () => {
  it("summarizes found fonts without requiring a DOM", () => {
    expect(describeFontStatus({ found: ["msyh.ttc", "simsun.ttc", "dengxian.ttf", "extra.ttf"] }))
      .toBe("发现 4 个中文字体：msyh.ttc, simsun.ttc, dengxian.ttf…");
  });

  it("describes the no-font recovery state", () => {
    expect(describeFontStatus({ found: [] })).toBe("中文字体已移除");
  });
});
