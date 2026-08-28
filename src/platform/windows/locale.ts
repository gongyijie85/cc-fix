import { AuthorityError, createWindowsAuthority, type WindowsAuthority } from './authority.js';
import { storedMissing, storedValue, type StoredValue } from '../../state/schema.js';

const languageTag = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
export interface LocaleRegistry { readLocale(): Promise<string | null>; writeLocale(value: string): Promise<void>; removeLocale(): Promise<void>; readLanguages(): Promise<string[] | null>; writeLanguages(value: string[]): Promise<void>; removeLanguages(): Promise<void>; readCulture(): Promise<string | null>; writeCulture(value: string): Promise<void>; removeCulture(): Promise<void>; }
const validTag = (value: unknown): value is string => typeof value === 'string' && languageTag.test(value);
const languageBase = (tag: string): string => tag.split('-')[0]!.toLowerCase();

/**
 * Windows 在未安装区域语言包时会把 ja-JP 折叠为 ja（en-US → en-US、zh-Hans-CN 保留区域）。
 * 读回验证按基础语言比对，避免深度保护在无语言包的机器上因字面不等而整体回滚。
 */
function languageListsEquivalent(desired: string[], actual: string[]): boolean {
  if (desired.length !== actual.length) return false;
  return desired.every((tag, index) => languageBase(tag) === languageBase(actual[index]!));
}

function validateLanguages(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(validTag);
}

export function createLocaleAuthorities(registry: LocaleRegistry): Readonly<{ localeName: WindowsAuthority<string>; userLanguages: WindowsAuthority<string[]>; userCulture: WindowsAuthority<string> }> {
  return Object.freeze({
    localeName: createWindowsAuthority('locale_name', { readRaw: () => registry.readLocale(), writeRaw: (value) => registry.writeLocale(value), removeRaw: () => registry.removeLocale(), validate: validTag }),
    userLanguages: Object.freeze({
      id: 'user_languages',
      read: async () => {
        const raw = await registry.readLanguages();
        if (raw === null) return storedMissing<string[]>();
        if (!validateLanguages(raw)) throw new AuthorityError('INVALID_VALUE', 'Invalid value read from user_languages');
        return storedValue(raw);
      },
      write: async (value: StoredValue<string[]>) => {
        if (value.kind === 'value') {
          if (!validateLanguages(value.value)) throw new AuthorityError('INVALID_VALUE', 'Invalid value for user_languages');
          await registry.writeLanguages(value.value);
        } else {
          await registry.removeLanguages();
        }
        const actual = await registry.readLanguages();
        const expected = value.kind === 'value' ? value.value : [];
        if (actual === null) {
          if (expected.length > 0) throw new AuthorityError('READBACK_MISMATCH', 'Readback did not match user_languages');
          return;
        }
        if (!languageListsEquivalent(expected, actual)) {
          throw new AuthorityError('READBACK_MISMATCH', 'Readback did not match user_languages');
        }
      },
    }),
    userCulture: createWindowsAuthority('user_culture', { readRaw: () => registry.readCulture(), writeRaw: (value) => registry.writeCulture(value), removeRaw: () => registry.removeCulture(), validate: validTag }),
  });
}