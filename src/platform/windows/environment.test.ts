import { describe, expect, it } from 'vitest';
import { createEnvironmentAuthority, createEnvironmentProfileAuthority } from './environment.js';
import { storedMissing, storedValue } from '../../state/schema.js';

describe('environment authority', () => {
  it('only permits fixed managed names and restores missing values', async () => {
    const values = new Map<string, string>();
    const registry = { read: async (key: 'TZ' | 'LANG' | 'LC_ALL') => values.get(key) ?? null, write: async (key: 'TZ' | 'LANG' | 'LC_ALL', value: string) => { values.set(key, value); }, remove: async (key: 'TZ' | 'LANG' | 'LC_ALL') => { values.delete(key); } };
    const authority = createEnvironmentAuthority(registry, 'TZ');
    await authority.write(storedValue('Asia/Tokyo'));
    expect(await authority.read()).toEqual(storedValue('Asia/Tokyo'));
    await authority.write(storedMissing());
    expect(await authority.read()).toEqual(storedMissing());
    expect(() => createEnvironmentAuthority(registry, 'PATH' as never)).toThrow('Unmanaged');
  });
  it('treats the three environment values as one recoverable profile', async () => {
    const values = new Map<string, string>([['TZ', 'old']]);
    const registry = { read: async (key: 'TZ' | 'LANG' | 'LC_ALL') => values.get(key) ?? null, write: async (key: 'TZ' | 'LANG' | 'LC_ALL', value: string) => { values.set(key, value); }, remove: async (key: 'TZ' | 'LANG' | 'LC_ALL') => { values.delete(key); } };
    const authority = createEnvironmentProfileAuthority(registry);
    await authority.write(storedValue({ TZ: 'Asia/Tokyo', LANG: 'ja_JP.UTF-8', LC_ALL: 'ja_JP.UTF-8' }));
    expect(await authority.read()).toEqual(storedValue({ TZ: 'Asia/Tokyo', LANG: 'ja_JP.UTF-8', LC_ALL: 'ja_JP.UTF-8' }));
  });
});
