// 系统字体检测插件 — 扫描 Windows Fonts 目录检测中文字体

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";

// 中文字体文件名模式（不区分大小写）
const CHINESE_FONT_PATTERNS = [
  "msyh",       // Microsoft YaHei（微软雅黑）
  "simsun",     // 宋体
  "simhei",     // 黑体
  "simkai",     // 楷体
  "simfang",    // 仿宋
  "stsong",     // STSong
  "stzhongs",   // STZhongsong
  "stkaiti",    // STKaiti
  "mingliu",    // MingLiU（细明体）
  "pmingliu",   // PMingLiU
  "dengxian",   // 等线
  "fzht",       // 方正黑体
  "fzft",       // 方正仿宋
  "fzkaiti",    // 方正楷体
  "fzsongti",   // 方正宋体
  "hwxh",       // 华文行楷
  "stxihei",    // 华文细黑
  "yahei",      // YaHei 变体
];

function getFontsDir(): string {
  return process.env.SystemRoot
    ? join(process.env.SystemRoot, "Fonts")
    : "C:\\Windows\\Fonts";
}

function detectChineseFonts(): string[] {
  try {
    const fontsDir = getFontsDir();
    const files = readdirSync(fontsDir);
    const lower = files.map((f) => f.toLowerCase());
    const found: string[] = [];

    for (const pattern of CHINESE_FONT_PATTERNS) {
      const match = lower.find((f) => f.includes(pattern));
      if (match) {
        found.push(match);
      }
    }

    return found;
  } catch {
    return [];
  }
}

export const fontsPlugin: DetectionPlugin = {
  id: "fonts",
  label: "系统字体",
  weight: 10,
  run: async (_context: DetectionContext): Promise<SignalResult> => {
    const chineseFonts = detectChineseFonts();
    const hasChineseFonts = chineseFonts.length > 0;

    return {
      id: "fonts",
      label: "系统字体",
      value: hasChineseFonts
        ? `发现 ${chineseFonts.length} 个中文字体 (${chineseFonts.slice(0, 3).join(", ")}${chineseFonts.length > 3 ? "..." : ""})`
        : "未发现中文字体",
      score: hasChineseFonts ? 1 : 0,
      weight: 10,
      contribution: hasChineseFonts ? 10 : 0,
      source: "system",
      risk: hasChineseFonts ? "high" : "low",
    };
  },
};
