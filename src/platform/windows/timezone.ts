import { createWindowsAuthority, type WindowsAuthority } from './authority.js';

/** 地区目录（targets.ts 期望值来源）当前覆盖的 Windows 时区 id；只作目录文档，不作运行时闸门（#35）。 */
export const APPROVED_WINDOWS_TIMEZONES = ['Eastern Standard Time', 'GMT Standard Time', 'Tokyo Standard Time', 'Singapore Standard Time'] as const;
export type ApprovedWindowsTimezone = (typeof APPROVED_WINDOWS_TIMEZONES)[number];
export interface TimezoneSystem { read(): Promise<string | null>; write(id: string): Promise<void>; }

const TIMEZONE_ID_PATTERN = /^[\x20-\x7E]{1,128}$/u;

/**
 * 时区权威（#35）：读侧接受任意合法时区 id（persist on 必须能捕获 UTC、China Standard Time
 * 等目录外原值）；写侧不做目录校验——期望值本就只由地区目录产出，还原方向写入的是自捕获原值，
 * 任意非法 id 由 tzutil 拒绝并经读回验证（READBACK_MISMATCH）拦截。
 */
export function createTimezoneAuthority(system: TimezoneSystem): WindowsAuthority<string> {
  return createWindowsAuthority('system_timezone', {
    readRaw: () => system.read(),
    writeRaw: async (value) => {
      await system.write(value);
    },
    removeRaw: async () => { throw new Error('System timezone cannot be removed'); },
    validate: (value): value is string => typeof value === 'string' && TIMEZONE_ID_PATTERN.test(value),
  });
}
