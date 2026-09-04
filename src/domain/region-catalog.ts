// 地区目录（#99）：纯领域数据与解析，不依赖 detection/CLI 层。
// 检测与 persist 两侧共用同一事实源；平台侧（timezone/winTimezone/lang/lcAll）
// 仅为权威存储期望值的数据，不引入任何 I/O。
import { parseRegionCode, type RegionCode } from "./region.js";

export interface RegionCatalogEntry {
  code: RegionCode;
  name: string;
  timezone: string;
  winTimezone: string;
  lang: string;
  lcAll: string;
}

export const TARGET_REGIONS = {
  us: {
    code: "us",
    name: "United States",
    timezone: "America/New_York",
    winTimezone: "Eastern Standard Time",
    lang: "en_US.UTF-8",
    lcAll: "en_US.UTF-8",
  },
  eu: {
    code: "eu",
    name: "Europe",
    timezone: "Europe/London",
    winTimezone: "GMT Standard Time",
    lang: "en_GB.UTF-8",
    lcAll: "en_GB.UTF-8",
  },
  jp: {
    code: "jp",
    name: "Japan",
    timezone: "Asia/Tokyo",
    winTimezone: "Tokyo Standard Time",
    lang: "ja_JP.UTF-8",
    lcAll: "ja_JP.UTF-8",
  },
  sg: {
    code: "sg",
    name: "Singapore",
    timezone: "Asia/Singapore",
    winTimezone: "Singapore Standard Time",
    lang: "en_SG.UTF-8",
    lcAll: "en_SG.UTF-8",
  },
} satisfies Record<RegionCode, RegionCatalogEntry>;

export const DEFAULT_REGION = "us" satisfies RegionCode;

export function getTargetRegion(code: string): RegionCatalogEntry {
  return TARGET_REGIONS[parseRegionCode(code, "explicit")];
}
