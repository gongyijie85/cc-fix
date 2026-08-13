import { describe, expect, it } from 'vitest';
import { storedValue } from '../../state/schema.js';
import { createWindowsAuthority } from './authority.js';
import { createPersistAuthoritySet } from './adapter-set.js';
describe('persist authority set', () => {
  it('exposes only the fixed persist vocabulary to the executor', async () => {
    let value = 'old';
    const authority = createWindowsAuthority('x', { readRaw: async () => value, writeRaw: async (next) => { value = next; }, removeRaw: async () => undefined, validate: (next): next is string => typeof next === 'string' });
    const set = createPersistAuthoritySet(Object.fromEntries(['environment','system_timezone','browser_policies','locale_name','user_languages','user_culture'].map((id) => [id, authority])) as never);
    await set.environment.write(storedValue('new'));
    expect((await set.environment.read())).toEqual(storedValue('new'));
  });
});
