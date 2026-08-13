import { describe, expect, it } from 'vitest';
import { createBrowserPolicyAuthority } from './browser-policy.js';
import { storedValue } from '../../state/schema.js';
describe('browser policy authority', () => {
  it('restricts operations to the catalogued policy slots', async () => {
    let value: string | null = null;
    const registry = { read: async () => value, write: async (_slot: string, next: string) => { value = next; }, remove: async () => { value = null; } };
    const authority = createBrowserPolicyAuthority(registry, 'chrome.webrtc');
    await authority.write(storedValue('disable_non_proxied_udp'));
    expect(await authority.read()).toEqual(storedValue('disable_non_proxied_udp'));
    expect(() => createBrowserPolicyAuthority(registry, 'chrome.anything' as never)).toThrow('Unmanaged');
  });
});
