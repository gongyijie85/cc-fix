import { describe, expect, it } from 'vitest';
import { createTimezoneAuthority } from './timezone.js';
import { storedValue } from '../../state/schema.js';
describe('timezone authority', () => {
  it('accepts only region-catalog Windows timezone IDs and verifies readback', async () => {
    let current = 'Eastern Standard Time';
    const authority = createTimezoneAuthority({ read: async () => current, write: async (value) => { current = value; } });
    await authority.write(storedValue('Tokyo Standard Time'));
    expect(await authority.read()).toEqual(storedValue('Tokyo Standard Time'));
    await expect(authority.write(storedValue('x; tzutil /s bad'))).rejects.toThrow('Unapproved');
  });
});
