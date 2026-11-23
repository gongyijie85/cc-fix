// 标量一致性插件工厂：高危 1.0 / 未对齐 0.5 / 对齐 0（跨插件统一规则，单点化）。
// weight 只声明一次，contribution 自动派生，消除同文件双写漂移面。

import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";

export type ScalarConsistencyConfig = Readonly<{
  id: string;
  label: string;
  weight: number;
  read: (context: DetectionContext) => Promise<string>;
  isHighRisk: (value: string) => boolean;
  isTarget: (value: string, context: DetectionContext) => boolean;
}>;

/** 高危优先于未对齐：命中高危表时即使与目标一致也保持 high（见各插件回归用例）。 */
function scoreScalar(value: string, config: ScalarConsistencyConfig, context: DetectionContext): {
  score: number;
  risk: SignalResult["risk"];
} {
  if (config.isHighRisk(value)) return { score: 1, risk: "high" };
  if (!config.isTarget(value, context)) return { score: 0.5, risk: "medium" };
  return { score: 0, risk: "low" };
}

export function createScalarConsistencyPlugin(config: ScalarConsistencyConfig): DetectionPlugin {
  return {
    id: config.id,
    label: config.label,
    weight: config.weight,
    run: async (context: DetectionContext): Promise<SignalResult> => {
      const value = await config.read(context);
      const { score, risk } = scoreScalar(value, config, context);
      return {
        id: config.id,
        label: config.label,
        value,
        score,
        weight: config.weight,
        contribution: Math.round(score * config.weight),
        source: "system",
        risk,
      };
    },
  };
}
