// 浏览器策略检测插件 — 检查 Chrome/Edge HKCU 策略槽位是否就位（ADR-0003）
// 槽事实与期望值全部派生自 state/schema.ts 槽目录（ADR-0011）

import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";
import { BROWSER_LABELS, getPolicy } from "../../platform/browser.js";
import {
  BROWSER_POLICY_SLOTS,
  BROWSER_POLICY_VALUE_NAMES,
  desiredBrowserPolicies,
} from "../../state/schema.js";

const SLOT_LABELS: Record<string, string> = {
  [BROWSER_POLICY_VALUE_NAMES.acceptLanguage]: "AcceptLanguage",
  [BROWSER_POLICY_VALUE_NAMES.webrtc]: "WebRTC 防泄漏",
  [BROWSER_POLICY_VALUE_NAMES.applicationLocale]: "ApplicationLocale",
};

export const browserPolicyPlugin: DetectionPlugin = {
  id: "browser-policy",
  label: "浏览器策略",
  weight: 5,
  run: async (context: DetectionContext): Promise<SignalResult> => {
    const targets = desiredBrowserPolicies(context.targetLang);

    // 逐槽位比对：缺失或取值不符记为异常，附当前值
    const badSlots: string[] = [];
    for (const slot of BROWSER_POLICY_SLOTS) {
      const current = await getPolicy(slot.id);
      if (current !== targets[slot.id]) {
        const name = SLOT_LABELS[slot.valueName] ?? slot.valueName;
        badSlots.push(`${BROWSER_LABELS[slot.browser]}/${name}=${current ?? "(未设置)"}`);
      }
    }

    const total = BROWSER_POLICY_SLOTS.length;
    const score = badSlots.length / total;
    const risk: SignalResult["risk"] =
      badSlots.length === 0 ? "low" : badSlots.length <= 2 ? "medium" : "high";

    return {
      id: "browser-policy",
      label: "浏览器策略",
      value:
        badSlots.length === 0
          ? `已就位（${total}/${total} 槽位规范）`
          : `${badSlots.length}/${total} 槽位异常：${badSlots.join("；")}`,
      score,
      weight: 5,
      contribution: Math.round(score * 5),
      source: "system",
      risk,
    };
  },
};
