// 检测插件接口

import type { SignalResult } from "./types.js";

export type DetectionContext = {
  targetTimezone: string;
  targetLang: string;
};

export type DetectionPlugin = {
  id: string;
  label: string;
  weight: number;
  run: (context: DetectionContext) => Promise<SignalResult>;
};
