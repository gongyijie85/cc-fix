// Runner 测试 — 插件逐个故障隔离

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "../events/types.js";
import type { SignalResult } from "./types.js";

// 可控的假插件工厂：state.failing 中的插件 id 会在 run 时抛错
const { state, makePlugin } = vi.hoisted(() => {
  const state = { failing: new Set<string>() };
  const makePlugin = (id: string) => ({
    id,
    label: id,
    weight: 10,
    run: async (): Promise<SignalResult> => {
      if (state.failing.has(id)) throw new Error(`${id} boom`);
      return {
        id,
        label: id,
        value: "ok",
        score: 0,
        weight: 10,
        contribution: 0,
        source: "system",
        risk: "low",
      };
    },
  });
  return { state, makePlugin };
});

vi.mock("./plugins/timezone.js", () => ({ timezonePlugin: makePlugin("timezone") }));
vi.mock("./plugins/language.js", () => ({ languagePlugin: makePlugin("language") }));
vi.mock("./plugins/locale.js", () => ({ localePlugin: makePlugin("locale") }));
vi.mock("./plugins/consistency.js", () => ({
  createConsistencyPlugin: () => makePlugin("consistency"),
}));
vi.mock("./plugins/fonts.js", () => ({ fontsPlugin: makePlugin("fonts") }));
vi.mock("./plugins/dns.js", () => ({ dnsPlugin: makePlugin("dns") }));
vi.mock("./plugins/base-url.js", () => ({ baseUrlPlugin: makePlugin("base-url") }));
vi.mock("./plugins/proxy.js", () => ({ proxyPlugin: makePlugin("proxy-env") }));
vi.mock("./plugins/win-region.js", () => ({ winRegionPlugin: makePlugin("win-region") }));
vi.mock("./plugins/utc-offset.js", () => ({ utcOffsetPlugin: makePlugin("utc-offset") }));
vi.mock("./plugins/browser-policy.js", () => ({ browserPolicyPlugin: makePlugin("browser-policy") }));

import { runDetection } from "./runner.js";

describe("runDetection 插件故障隔离", () => {
  beforeEach(() => {
    state.failing.clear();
  });

  it("所有插件正常时汇总全部 11 个信号且无降级事件", async () => {
    const events: StreamEvent[] = [];
    const response = await runDetection("auto", "America/New_York", "en", null, (e) =>
      events.push(e)
    );

    expect(events.filter((e) => e.type === "detect-degraded")).toHaveLength(0);
    expect(events.filter((e) => e.type === "detect-ok")).toHaveLength(11);
    expect(response.signals).toHaveLength(11);
    expect(typeof response.score).toBe("number");
  });

  it("IP 情报派生信号走插件 seam，信号与事件并入汇总", async () => {
    const events: StreamEvent[] = [];
    const response = await runDetection("auto", "America/New_York", "en", {
      ipType: "datacenter", asn: "AS13335", org: "Cloudflare", sourceCount: 2, multiSourceConsistent: false,
    }, (e) => events.push(e));
    const okIds = events
      .filter((e): e is Extract<StreamEvent, { type: "detect-ok" }> => e.type === "detect-ok")
      .map((e) => e.signal.id);
    expect(okIds).toContain("ip-datacenter");
    expect(okIds).toContain("ip-multi-source");
    expect(response.signals.map((s) => s.id).slice(-2)).toEqual(["ip-datacenter", "ip-multi-source"]);
  });

  it("单个插件抛错时发射降级事件，其余信号仍正常汇总", async () => {
    state.failing.add("dns");
    const events: StreamEvent[] = [];
    const response = await runDetection("auto", "America/New_York", "en", null, (e) =>
      events.push(e)
    );

    // 故障插件发射降级事件并携带错误信息
    const degraded = events.filter((e) => e.type === "detect-degraded");
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({
      type: "detect-degraded",
      pluginId: "dns",
      error: "dns boom",
    });

    // 其余 10 个插件的信号正常发射并进入汇总
    const okIds = events
      .filter((e): e is Extract<StreamEvent, { type: "detect-ok" }> => e.type === "detect-ok")
      .map((e) => e.signal.id);
    expect(okIds).toHaveLength(10);
    expect(okIds).not.toContain("dns");
    expect(response.signals.map((s) => s.id).sort()).toEqual(okIds.slice().sort());

    // 仍产出完整汇总结果
    expect(events.some((e) => e.type === "detect-done")).toBe(true);
    expect(response.signals).toHaveLength(10);
    expect(response.score).toBe(0);
    expect(response.region).toBe("auto");
  });
});
