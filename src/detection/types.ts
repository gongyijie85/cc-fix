// CC-Fix 核心类型定义

import type { RegionCode } from "../domain/region.js";

/** 访问区语义值：运行时只有 auto（自动判定）；cn/ru/ir 为访问区预留面（#68 决议保留）。 */
export type AccessRegionCode = "auto" | "cn" | "ru" | "ir";
export type AccessStatus = "supported" | "possibly_supported" | "restricted" | "unsupported" | "unknown";
export type SignalSource = "system" | "network" | "combined";

export type SignalResult = {
  id: string;
  label: string;
  value: string | null;
  score: number;
  weight: number;
  contribution: number;
  source: SignalSource;
  risk: "low" | "medium" | "high" | "critical";
};

export type IpIntelligence = {
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  asn: string | null;
  org: string | null;
  timezone: string | null;
  // Phase 2 新增
  ipType: "residential" | "datacenter" | "unknown";
  multiSourceConsistent: boolean;
  sourceCount: number;
};

export type CheckResponse = {
  score: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  status: AccessStatus;
  region: AccessRegionCode;
  matchedRegion: Exclude<AccessRegionCode, "auto"> | null;
  signals: SignalResult[];
  ipIntelligence: IpIntelligence | null;
  recommendations: string[];
};


export type TargetRegion = {
  code: RegionCode;
  name: string;
  timezone: string;
  /** 对应的 Windows tzutil 时区 ID，用于同步切换系统时区（浏览器指纹） */
  winTimezone: string;
  lang: string;
  lcAll: string;
};
