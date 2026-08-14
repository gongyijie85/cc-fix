// 检测信号目录（评审候选 7）— 服务端唯一定义，经 SSE catalog 事件下发给 GUI。

import { timezonePlugin } from "./plugins/timezone.js";
import { languagePlugin } from "./plugins/language.js";
import { localePlugin } from "./plugins/locale.js";
import { createConsistencyPlugin } from "./plugins/consistency.js";
import { dnsPlugin } from "./plugins/dns.js";
import { fontsPlugin } from "./plugins/fonts.js";
import { baseUrlPlugin } from "./plugins/base-url.js";
import { proxyPlugin } from "./plugins/proxy.js";
import { winRegionPlugin } from "./plugins/win-region.js";
import { utcOffsetPlugin } from "./plugins/utc-offset.js";
import { browserPolicyPlugin } from "./plugins/browser-policy.js";

export type SignalCatalogEntry = { id: string; label: string };

/** 与运行器插件数组同序（IP 派生信号在末尾），GUI 渲染顺序即此目录。 */
export function signalCatalog(): SignalCatalogEntry[] {
  const consistency = createConsistencyPlugin(null);
  return [
    timezonePlugin,
    languagePlugin,
    localePlugin,
    { id: consistency.id, label: consistency.label },
    fontsPlugin,
    dnsPlugin,
    baseUrlPlugin,
    proxyPlugin,
    winRegionPlugin,
    utcOffsetPlugin,
    browserPolicyPlugin,
    { id: "ip-datacenter", label: "数据中心 IP" },
    { id: "ip-multi-source", label: "多源不一致" },
  ].map((p) => ({ id: p.id, label: p.label }));
}
