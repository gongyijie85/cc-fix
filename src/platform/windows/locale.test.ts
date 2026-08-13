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
