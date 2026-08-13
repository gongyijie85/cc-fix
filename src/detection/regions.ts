// 目标地区配置

import type { TargetRegion } from "../detection/types.js";
import {
  parseRegionCode,
  type RegionCode,
} from "../domain/region.js";

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
} satisfies Record<RegionCode, TargetRegion>;

export const DEFAULT_REGION = "us" satisfies RegionCode;

export function getTargetRegion(code: string): TargetRegion {
  return TARGET_REGIONS[parseRegionCode(code, "explicit")];
}
