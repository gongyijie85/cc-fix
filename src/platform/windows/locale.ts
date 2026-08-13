import { createWindowsAuthority, type WindowsAuthority } from './authority.js';

const languageTag = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
export interface LocaleRegistry { readLocale(): Promise<string | null>; writeLocale(value: string): Promise<void>; removeLocale(): Promise<void>; readLanguages(): Promise<string[] | null>; writeLanguages(value: string[]): Promise<void>; removeLanguages(): Promise<void>; readCulture(): Promise<string | null>; writeCulture(value: string): Promise<void>; removeCulture(): Promise<void>; }
const validTag = (value: unknown): value is string => typeof value === 'string' && languageTag.test(value);
export function createLocaleAuthorities(registry: LocaleRegistry): Readonly<{ localeName: WindowsAuthority<string>; userLanguages: WindowsAuthority<string[]>; userCulture: WindowsAuthority<string> }> {
  return Object.freeze({
    localeName: createWindowsAuthority('locale_name', { readRaw: () => registry.readLocale(), writeRaw: (value) => registry.writeLocale(value), removeRaw: () => registry.removeLocale(), validate: validTag }),
    userLanguages: createWindowsAuthority('user_languages', { readRaw: () => registry.readLanguages(), writeRaw: (value) => registry.writeLanguages(value), removeRaw: () => registry.removeLanguages(), validate: (value): value is string[] => Array.isArray(value) && value.every(validTag) }),
    userCulture: createWindowsAuthority('user_culture', { readRaw: () => registry.readCulture(), writeRaw: (value) => registry.writeCulture(value), removeRaw: () => registry.removeCulture(), validate: validTag }),
  });
}
