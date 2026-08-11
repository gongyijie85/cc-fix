// CC-Fix 核心类型定义

import type { RegionCode as TargetRegionCode } from "../domain/region.js";

export type RegionCode = "auto" | "cn" | "ru" | "ir";
export type AccessStatus = "supported" | "possibly_supported" | "restricted" | "unsupported" | "unknown";
export type SignalSource = "system" | "network" | "combined";

export type ProductAccess = {
  web: AccessStatus;
  pro: AccessStatus;
  api: AccessStatus;
  payment: AccessStatus;
};

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

export type RegionProfile = {
  code: Exclude<RegionCode, "auto">;
  name: string;
  shortName: string;
  countries: string[];
  timezones: string[];
  languages: string[];
  browserPatterns: string[];
  weights: Record<string, number>;
  products: ProductAccess;
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
  region: RegionCode;
  matchedRegion: Exclude<RegionCode, "auto"> | null;
  signals: SignalResult[];
  ipIntelligence: IpIntelligence | null;
  recommendations: string[];
};

export type PersistState = {
  enabled: boolean;
  region: RegionCode;
  envVars: Record<string, string | null>;
  backupFile: string | null;
};

export type TargetRegion = {
  code: TargetRegionCode;
  name: string;
  timezone: string;
  /** 对应的 Windows tzutil 时区 ID，用于同步切换系统时区（浏览器指纹） */
  winTimezone: string;
  lang: string;
  lcAll: string;
};
