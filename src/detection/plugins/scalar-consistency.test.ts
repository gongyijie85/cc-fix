// 标量一致性插件工厂：评分规则单点化后的契约测试

import { describe, it, expect } from "vitest";
import { createScalarConsistencyPlugin } from "./scalar-consistency.js";

const base = {
  id: "demo",
  label: "演示",
  weight: 20,
};

describe("createScalarConsistencyPlugin", () => {
  const ctx = { targetTimezone: "America/New_York", targetLang: "en_US" };

  it("对齐目标且非高危 → score 0 / low / contribution 0", async () => {
    const plugin = createScalarConsistencyPlugin({
      ...base,
      read: async () => "ok",
      isHighRisk: () => false,
      isTarget: () => true,
    });
    const r = await plugin.run(ctx);
    expect(r.score).toBe(0);
    expect(r.risk).toBe("low");
    expect(r.contribution).toBe(0);
    expect(r.weight).toBe(20);
  });

  it("未对齐且非高危 → score 0.5 / medium / contribution = round(0.5*weight)", async () => {
    const plugin = createScalarConsistencyPlugin({
      ...base,
      read: async () => "other",
      isHighRisk: () => false,
      isTarget: () => false,
    });
    const r = await plugin.run(ctx);
    expect(r.score).toBe(0.5);
    expect(r.risk).toBe("medium");
    expect(r.contribution).toBe(10);
  });

  it("高危优先于未对齐 → score 1 / high", async () => {
    const plugin = createScalarConsistencyPlugin({
      ...base,
      read: async () => "danger",
      isHighRisk: () => true,
      isTarget: () => false,
    });
    const r = await plugin.run(ctx);
    expect(r.score).toBe(1);
    expect(r.risk).toBe("high");
    expect(r.contribution).toBe(20);
  });

  it("高危优先于目标一致（匹配目标仍保持 high）", async () => {
    const plugin = createScalarConsistencyPlugin({
      ...base,
      read: async () => "danger-but-target",
      isHighRisk: () => true,
      isTarget: () => true,
    });
    const r = await plugin.run(ctx);
    expect(r.score).toBe(1);
    expect(r.risk).toBe("high");
    expect(r.contribution).toBe(20);
  });

  it("weight 只在配置声明一次，contribution 由 weight 派生", async () => {
    const plugin = createScalarConsistencyPlugin({
      ...base,
      weight: 7,
      read: async () => "x",
      isHighRisk: () => true,
      isTarget: () => false,
    });
    const r = await plugin.run(ctx);
    expect(r.weight).toBe(7);
    expect(r.contribution).toBe(7);
    expect(plugin.weight).toBe(7);
  });
});
