// 浏览器策略检测插件 — 检查 Chrome/Edge HKCU 策略槽位是否就位（ADR-0003）
// 规范值与 persist 写入共用 platform/browser.ts 同一事实源

import type { DetectionPlugin, DetectionContext } from "../plugin.js";
import type { SignalResult } from "../types.js";
import {
  POLICY_SLOTS,
  slotKey,
  getPolicy,
  targetPolicies,
  BROWSER_LABELS,
  ACCEPT_LANGUAGE_NAME,
  WEBRTC_POLICY_NAME,
  APPLICATION_LOCALE_NAME,
} from "../../platform/browser.js";

const SLOT_LABELS: Record<string, string> = {
  [ACCEPT_LANGUAGE_NAME]: "AcceptLanguage",
  [WEBRTC_POLICY_NAME]: "WebRTC 防泄漏",
  [APPLICATION_LOCALE_NAME]: "ApplicationLocale",
};

export const browserPolicyPlugin: DetectionPlugin = {
  id: "browser-policy",
  label: "浏览器策略",
  weight: 5,
  run: async (context: DetectionContext): Promise<SignalResult> => {
    const targets = targetPolicies(context.targetLang);

    // 逐槽位比对：缺失或取值不符记为异常，附当前值
    const badSlots: string[] = [];
    for (const slot of POLICY_SLOTS) {
      const key = slotKey(slot);
      const current = getPolicy(slot.browser, slot.name);
      if (current !== targets[key]) {
        const name = SLOT_LABELS[slot.name] ?? slot.name;
        badSlots.push(`${BROWSER_LABELS[slot.browser]}/${name}=${current ?? "(未设置)"}`);
      }
    }

    const total = POLICY_SLOTS.length;
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
