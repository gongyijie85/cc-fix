import { describe, expect, it } from 'vitest';
import { createTimezoneAuthority } from './timezone.js';
import { storedValue } from '../../state/schema.js';
describe('timezone authority', () => {
  it('reads any valid timezone id, including out-of-catalogue originals (#35)', async () => {
    const authority = createTimezoneAuthority({ read: async () => 'UTC', write: async () => undefined });
    expect(await authority.read()).toEqual(storedValue('UTC'));
    const china = createTimezoneAuthority({ read: async () => 'China Standard Time', write: async () => undefined });
    expect(await china.read()).toEqual(storedValue('China Standard Time'));
  });

  it('writes catalogue values and verifies readback', async () => {
    let current = 'Eastern Standard Time';
    const authority = createTimezoneAuthority({ read: async () => current, write: async (value) => { current = value; } });
    await authority.write(storedValue('Tokyo Standard Time'));
    expect(await authority.read()).toEqual(storedValue('Tokyo Standard Time'));
  });

  it('rejects non-printable values at the boundary and lets tzutil failures propagate', async () => {
    let current = 'Eastern Standard Time';
    const authority = createTimezoneAuthority({
      read: async () => current,
      write: async (value) => { if (value.includes(';')) throw new Error('The time zone ID is invalid'); current = value; },
    });
    await expect(authority.write(storedValue('x; tzutil /s bad'))).rejects.toThrow('invalid');
    await expect(authority.write(storedValue('bad id 时区'))).rejects.toThrow('Invalid value');
  });
});
