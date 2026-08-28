// 系统字体检测插件 — 扫描 Windows Fonts 目录检测中文字体（目录派生自 src/fonts/catalog.ts，ADR-0013）

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";
import { isChineseFontFileName } from "../../fonts/catalog.js";

function getFontsDir(): string {
  return process.env.SystemRoot
    ? join(process.env.SystemRoot, "Fonts")
    : "C:\\Windows\\Fonts";
}

async function detectChineseFonts(): Promise<string[]> {
  try {
    const files = await readdir(getFontsDir());
    const found = new Set<string>();
    for (const file of files) {
      if (isChineseFontFileName(file)) found.add(file);
    }
    return [...found].sort();
  } catch {
    return [];
  }
}

export const fontsPlugin: DetectionPlugin = {
  id: "fonts",
  label: "系统字体",
  weight: 10,
  run: async (_context: DetectionContext): Promise<SignalResult> => {
    const chineseFonts = await detectChineseFonts();
    const hasChineseFonts = chineseFonts.length > 0;
    return {
      id: "fonts",
      label: "系统字体",
      value: hasChineseFonts
        ? `发现 ${chineseFonts.length} 个中文字体 (${chineseFonts.slice(0, 3).join(", ")}${chineseFonts.length > 3 ? "..." : ""})；系统内置字体不计风险`
        : "未发现中文字体",
      score: 0,
      weight: 10,
      contribution: 0,
      source: "system",
      risk: "low",
    };
  },
};
