import { describe, expect, it } from "vitest";
import { describeFontStatus, escapeHtml } from "../../assets/gui/renderers.js";

describe("font panel view model", () => {
  it("summarizes found fonts without requiring a DOM", () => {
    expect(describeFontStatus({ found: ["msyh.ttc", "simsun.ttc", "dengxian.ttf", "extra.ttf"] }))
      .toBe("发现 4 个中文字体：msyh.ttc, simsun.ttc, dengxian.ttf…");
  });

  it("describes the no-font recovery state", () => {
    expect(describeFontStatus({ found: [] })).toBe("中文字体已移除");
  });
});

// #90：远程 IP 情报与插件 value 是跨信任边界文本，innerHTML 插值前必须转义。
describe("escapeHtml (XSS regression, issue #90)", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<img src=x onerror=alert("&")>'`)).toBe(
      "&lt;img src=x onerror=alert(&quot;&amp;&quot;)&gt;&#39;",
    );
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("plain text 中文 1.2.3")).toBe("plain text 中文 1.2.3");
  });

  it("neutralizes a full script/event-handler payload", () => {
    const payload = `</td><script>alert(1)</script><img src=x onerror="steal()">`;
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain("<script>");
    expect(escaped).not.toContain("<img");
    expect(escaped).toContain("&lt;/td&gt;");
  });

  it("stringifies null and undefined inputs defensively", () => {
    expect(escapeHtml(null)).toBe("null");
    expect(escapeHtml(undefined)).toBe("undefined");
    expect(escapeHtml(0)).toBe("0");
  });
});
