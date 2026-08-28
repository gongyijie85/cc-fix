// 表格渲染测试 — 锁定 cli-table3 零依赖替代的字节级语义

import { describe, it, expect } from "vitest";
import { strlen, truncate, renderTable } from "./table.js";

describe("strlen（string-width v4 语义）", () => {
  it("counts ASCII as 1 and CJK as 2", () => {
    expect(strlen("abc")).toBe(3);
    expect(strlen("检测项")).toBe(6);
    expect(strlen("时区(Asia/Shanghai)≠目标(America/New_York)")).toBe(42);
  });

  it("counts emoji as 2 (replaced before width calc)", () => {
    expect(strlen("❌ 高风险")).toBe(9);
    expect(strlen("⚠️ 中风险")).toBe(9);
    expect(strlen("✅ 安全")).toBe(7);
  });

  it("strips ANSI codes before counting", () => {
    expect(strlen("\u001B[31m❌ 高风险\u001B[39m")).toBe(9);
    expect(strlen("\u001B[36m 检测项           \u001B[39m")).toBe(18);
  });

  it("ignores control and combining characters", () => {
    expect(strlen("\u0007a\u0007")).toBe(1);
    expect(strlen("a\u0300b")).toBe(2); // combining grave accent
  });
});

describe("truncate", () => {
  it("keeps text within width without ellipsis when it fits", () => {
    expect(truncate("安全", 6)).toBe("安全");
  });

  it("truncates wide content with an ellipsis", () => {
    expect(truncate("❌ 高风险", 6)).toBe("❌ 高…");
    expect(truncate("✅ 安全", 6)).toBe("✅ 安…");
  });

  it("truncates and keeps a single leading color span (chalk pattern)", () => {
    expect(truncate("\u001B[31m❌ 高风险\u001B[39m", 6)).toBe("\u001B[31m❌ 高\u001B[39m…");
  });

  it("truncates mixed CJK/ASCII content", () => {
    expect(truncate("时区(Asia/Shanghai)≠目标(America/New_York)", 26)).toBe("时区(Asia/Shanghai)≠目标(…");
    expect(truncate("发现 15 个中文字体 (STKAI...)", 26)).toBe("发现 15 个中文字体 (STKAI…");
  });
});

describe("renderTable", () => {
  it("renders head, bordered rows and separators byte-exactly", () => {
    const table = renderTable({
      head: ["检测项", "当前值", "风险", "风险分值"],
      colWidths: [18, 28, 8, 12],
      rows: [
        ["系统时区", "Asia/Shanghai", "\u001B[31m❌ 高风险\u001B[39m", "\u001B[31m+25\u001B[39m"],
        ["系统字体", "发现 15 个中文字体 (STKAI...)", "\u001B[32m✅ 安全\u001B[39m", "\u001B[32m+0\u001B[39m"],
      ],
    });
    const expected = [
      "\u001B[90m┌──────────────────\u001B[39m\u001B[90m┬────────────────────────────\u001B[39m\u001B[90m┬────────\u001B[39m\u001B[90m┬────────────┐\u001B[39m",
      "\u001B[90m│\u001B[39m\u001B[36m 检测项           \u001B[39m\u001B[90m│\u001B[39m\u001B[36m 当前值                     \u001B[39m\u001B[90m│\u001B[39m\u001B[36m 风险   \u001B[39m\u001B[90m│\u001B[39m\u001B[36m 风险分值   \u001B[39m\u001B[90m│\u001B[39m",
      "\u001B[90m├──────────────────\u001B[39m\u001B[90m┼────────────────────────────\u001B[39m\u001B[90m┼────────\u001B[39m\u001B[90m┼────────────┤\u001B[39m",
      "\u001B[90m│\u001B[39m 系统时区         \u001B[90m│\u001B[39m Asia/Shanghai              \u001B[90m│\u001B[39m \u001B[31m❌ 高\u001B[39m… \u001B[90m│\u001B[39m \u001B[31m+25\u001B[39m        \u001B[90m│\u001B[39m",
      "\u001B[90m├──────────────────\u001B[39m\u001B[90m┼────────────────────────────\u001B[39m\u001B[90m┼────────\u001B[39m\u001B[90m┼────────────┤\u001B[39m",
      "\u001B[90m│\u001B[39m 系统字体         \u001B[90m│\u001B[39m 发现 15 个中文字体 (STKAI… \u001B[90m│\u001B[39m \u001B[32m✅ 安\u001B[39m… \u001B[90m│\u001B[39m \u001B[32m+0\u001B[39m         \u001B[90m│\u001B[39m",
      "\u001B[90m└──────────────────\u001B[39m\u001B[90m┴────────────────────────────\u001B[39m\u001B[90m┴────────\u001B[39m\u001B[90m┴────────────┘\u001B[39m",
    ].join("\n");
    expect(table).toBe(expected);
  });
});
