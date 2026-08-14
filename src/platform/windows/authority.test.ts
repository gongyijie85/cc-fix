import { describe, expect, it } from 'vitest';
import { storedMissing, storedValue } from '../../state/schema.js';
import { AuthorityError, createWindowsAuthority } from './authority.js';

describe('Windows authority contract', () => {
  it('round-trips missing, empty and Unicode values through readback verification', async () => {
    let current: string | null = null;
    const authority = createWindowsAuthority('environment.TZ', {
      readRaw: async () => current,
      writeRaw: async (value) => { current = value; },
      removeRaw: async () => { current = null; },
      validate: (value): value is string => typeof value === 'string',
    });
    expect(await authority.read()).toEqual(storedMissing());
    await authority.write(storedValue(''));
    expect(await authority.read()).toEqual(storedValue(''));
    await authority.write(storedValue('日本語'));
    expect(await authority.read()).toEqual(storedValue('日本語'));
    await authority.write(storedMissing());
  });

  it('fails closed when a write cannot be proven by readback', async () => {
    const authority = createWindowsAuthority('locale', {
      readRaw: async () => 'en-US', writeRaw: async () => undefined, removeRaw: async () => undefined,
      validate: (value): value is string => typeof value === 'string',
    });
    await expect(authority.write(storedValue('ja-JP'))).rejects.toMatchObject({ code: 'READBACK_MISMATCH' } satisfies Partial<AuthorityError>);
  });
});
