// 地区目录（#99）：纯领域数据与解析，不依赖 detection/CLI 层。
// 检测与 persist 两侧共用同一事实源；平台侧（timezone/winTimezone/lang/lcAll）
// 仅为权威存储期望值的数据，不引入任何 I/O。
import { parseRegionCode, type RegionCode } from "./region.js";

export interface TargetTimezone {
  timezone: string;
  winTimezone: string;
  label: string;
}

// IANA / Windows 对照采用 Unicode CLDR windowsZones；只允许目录内的成对值。
export const REGION_TIMEZONES = {
  us: [
    { timezone: "America/New_York", winTimezone: "Eastern Standard Time", label: "纽约（东部）" },
    { timezone: "America/Los_Angeles", winTimezone: "Pacific Standard Time", label: "洛杉矶（太平洋）" },
    { timezone: "America/Chicago", winTimezone: "Central Standard Time", label: "芝加哥（中部）" },
    { timezone: "America/Denver", winTimezone: "Mountain Standard Time", label: "丹佛（山地）" },
  ],
  eu: [{ timezone: "Europe/London", winTimezone: "GMT Standard Time", label: "伦敦" }],
  jp: [{ timezone: "Asia/Tokyo", winTimezone: "Tokyo Standard Time", label: "东京" }],
  sg: [{ timezone: "Asia/Singapore", winTimezone: "Singapore Standard Time", label: "新加坡" }],
} as const satisfies Record<RegionCode, readonly TargetTimezone[]>;

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
    timezone: REGION_TIMEZONES.us[0].timezone,
    winTimezone: REGION_TIMEZONES.us[0].winTimezone,
    lang: "en_US.UTF-8",
    lcAll: "en_US.UTF-8",
  },
  eu: {
    code: "eu",
    name: "Europe",
    timezone: REGION_TIMEZONES.eu[0].timezone,
    winTimezone: REGION_TIMEZONES.eu[0].winTimezone,
    lang: "en_GB.UTF-8",
    lcAll: "en_GB.UTF-8",
  },
  jp: {
    code: "jp",
    name: "Japan",
    timezone: REGION_TIMEZONES.jp[0].timezone,
    winTimezone: REGION_TIMEZONES.jp[0].winTimezone,
    lang: "ja_JP.UTF-8",
    lcAll: "ja_JP.UTF-8",
  },
  sg: {
    code: "sg",
    name: "Singapore",
    timezone: REGION_TIMEZONES.sg[0].timezone,
    winTimezone: REGION_TIMEZONES.sg[0].winTimezone,
    lang: "en_SG.UTF-8",
    lcAll: "en_SG.UTF-8",
  },
} satisfies Record<RegionCode, RegionCatalogEntry>;

export const DEFAULT_REGION = "us" satisfies RegionCode;

export class TimezoneResolutionError extends Error {
  readonly code = "INVALID_TIMEZONE" as const;
  readonly validTimezones: readonly string[];

  constructor(readonly region: RegionCode, readonly value: unknown) {
    const valid = REGION_TIMEZONES[region].map((entry) => entry.timezone);
    super(`Invalid timezone for ${region}; expected one of: ${valid.join(", ")}`);
    this.name = "TimezoneResolutionError";
    this.validTimezones = valid;
  }
}

export function isRegionTimezone(region: RegionCode, value: unknown): value is string {
  return REGION_TIMEZONES[region].some((entry) => entry.timezone === value);
}

export function getTargetRegion(code: string, timezone?: unknown): RegionCatalogEntry {
  const region = TARGET_REGIONS[parseRegionCode(code, "explicit")];
  if (timezone === undefined) return region;
  const selected = REGION_TIMEZONES[region.code].find((entry) => entry.timezone === timezone);
  if (selected === undefined) throw new TimezoneResolutionError(region.code, timezone);
  return { ...region, timezone: selected.timezone, winTimezone: selected.winTimezone };
}

interface TargetTimezoneInput {
  region: RegionCode;
  explicit?: unknown;
  active?: { region: RegionCode; timezone?: string } | null;
  current?: string;
}

/** 仅在本机时区可能改变选择时返回 undefined。显式或已提交的值始终先校验。 */
export function knownTargetTimezone(input: TargetTimezoneInput): string | undefined {
  if (input.explicit !== undefined) return getTargetRegion(input.region, input.explicit).timezone;
  if (input.active?.region === input.region && input.active.timezone !== undefined) {
    return getTargetRegion(input.region, input.active.timezone).timezone;
  }
  const choices = REGION_TIMEZONES[input.region];
  return choices.length === 1 ? choices[0].timezone : undefined;
}

/** 显式选择 > 同地区已提交城市 > 本机已对齐城市 > 地区默认。 */
export function resolveTargetTimezone(input: TargetTimezoneInput): string {
  return knownTargetTimezone(input)
    ?? (isRegionTimezone(input.region, input.current) ? input.current : TARGET_REGIONS[input.region].timezone);
}
