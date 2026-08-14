import { describe, expect, it } from 'vitest';
import { createLocaleAuthorities } from './locale.js';
import { storedValue } from '../../state/schema.js';

describe('locale authorities', () => {
  it('preserves an empty language list distinctly and rejects invalid tags', async () => {
    let languages: string[] | null = [];
    const registry = { readLocale: async () => 'en-US', writeLocale: async () => undefined, removeLocale: async () => undefined, readLanguages: async () => languages, writeLanguages: async (value: string[]) => { languages = value; }, removeLanguages: async () => { languages = null; }, readCulture: async () => 'en-US', writeCulture: async () => undefined, removeCulture: async () => undefined };
    const { userLanguages } = createLocaleAuthorities(registry);
    expect(await userLanguages.read()).toEqual(storedValue([]));
    await userLanguages.write(storedValue(['ja-JP', 'en-US']));
    await expect(userLanguages.write(storedValue(['bad;value']))).rejects.toThrow('Invalid');
  });
});

describe('user languages normalization (issue #45)', () => {
  it('accepts a collapsed base tag on readback when the regional pack is absent', async () => {
    let stored: string[] = [];
    const registry = {
      readLocale: async () => 'ja-JP', writeLocale: async () => undefined, removeLocale: async () => undefined,
      readLanguages: async () => stored.length === 0 ? null : stored,
      writeLanguages: async (value: string[]) => { stored = value.map(t => t.split('-')[0]); },
      removeLanguages: async () => { stored = []; },
      readCulture: async () => 'ja-JP', writeCulture: async () => undefined, removeCulture: async () => undefined,
    };
    const authorities = createLocaleAuthorities(registry);
    await authorities.userLanguages.write(storedValue(['ja-JP']));
    expect(await authorities.userLanguages.read()).toEqual(storedValue(['ja']));
  });

  it('still fails the readback when the language genuinely differs', async () => {
    let stored: string[] = ['zh-Hans-CN'];
    const registry = {
      readLocale: async () => 'zh-CN', writeLocale: async () => undefined, removeLocale: async () => undefined,
      readLanguages: async () => stored,
      writeLanguages: async (value: string[]) => { stored = ['zh-Hans-CN']; },
      removeLanguages: async () => { stored = []; },
      readCulture: async () => 'zh-CN', writeCulture: async () => undefined, removeCulture: async () => undefined,
    };
    const authorities = createLocaleAuthorities(registry);
    await expect(authorities.userLanguages.write(storedValue(['ja-JP']))).rejects.toMatchObject({ code: 'READBACK_MISMATCH' });
  });
});