import { createWindowsAuthority, type WindowsAuthority } from './authority.js';

export const APPROVED_WINDOWS_TIMEZONES = ['Eastern Standard Time', 'GMT Standard Time', 'Tokyo Standard Time', 'Singapore Standard Time'] as const;
export type ApprovedWindowsTimezone = (typeof APPROVED_WINDOWS_TIMEZONES)[number];
export interface TimezoneSystem { read(): Promise<string | null>; write(id: ApprovedWindowsTimezone): Promise<void>; }

export function createTimezoneAuthority(system: TimezoneSystem): WindowsAuthority<string> {
  return createWindowsAuthority('system_timezone', {
    readRaw: () => system.read(),
    writeRaw: async (value) => {
      if (!APPROVED_WINDOWS_TIMEZONES.includes(value as ApprovedWindowsTimezone)) throw new Error('Unapproved Windows timezone');
      await system.write(value as ApprovedWindowsTimezone);
    },
    removeRaw: async () => { throw new Error('System timezone cannot be removed'); },
    validate: (value): value is string => typeof value === 'string' && APPROVED_WINDOWS_TIMEZONES.includes(value as ApprovedWindowsTimezone),
  });
}
