// Windows 区域格式检测插件 — 检查注册表 HKCU\Control Panel\International 的 LocaleName

import { execSync } from "node:child_process";
import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";

function getWindowsLocaleName(): string | null {
  try {
    const output = execSync(
      'reg query "HKCU\\Control Panel\\International" /v LocaleName',
      { encoding: "utf-8", timeout: 3000, windowsHide: true }
    );
    // 输出格式: "    LocaleName    REG_SZ    zh-CN"
    const match = output.match(/LocaleName\s+REG_SZ\s+(\S+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

// 安全的 LocaleName 值（不会触发风控）
const SAFE_LOCALES = new Set([
  "en-US", "en-GB", "en-AU", "en-CA",
  "ja-JP", "ko-KR", "de-DE", "fr-FR",
  "es-ES", "it-IT", "nl-NL", "pt-BR",
  "ru-RU", "pl-PL", "sv-SE", "nb-NO",
  "da-DK", "fi-FI", "tr-TR", "th-TH",
  "vi-VN", "id-ID", "ms-MY",
]);

// 高风险 LocaleName
const RISKY_LOCALES = new Set([
  "zh-CN", "zh-TW", "zh-HK", "zh-SG",
]);

export const winRegionPlugin: DetectionPlugin = {
  id: "win-region",
  label: "Windows 区域格式",
  weight: 4,
  run: async (_context: DetectionContext): Promise<SignalResult> => {
    const localeName = getWindowsLocaleName();

    if (!localeName) {
      return {
        id: "win-region",
        label: "Windows 区域格式",
        value: "(无法读取)",
        score: 0,
        weight: 4,
        contribution: 0,
        source: "system",
        risk: "low",
      };
    }

    const isRisky = RISKY_LOCALES.has(localeName);
    const isSafe = SAFE_LOCALES.has(localeName);

    let risk: SignalResult["risk"];
    let score: number;
    if (isRisky) {
      risk = "high";
      score = 1;
    } else if (isSafe) {
      risk = "low";
      score = 0;
    } else {
      risk = "medium";
      score = 0.5;
    }

    return {
      id: "win-region",
      label: "Windows 区域格式",
      value: localeName,
      score,
      weight: 4,
      contribution: score * 4,
      source: "system",
      risk,
    };
  },
};
