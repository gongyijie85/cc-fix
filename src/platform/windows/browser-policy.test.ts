import { describe, expect, it } from 'vitest';
import { createBrowserPolicyAuthority, createBrowserPolicyProfileAuthority } from './browser-policy.js';
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
  it('captures all six policy slots as one compensated profile', async () => {
    const values = new Map<string, string>();
    const registry = { read: async (slot: string) => values.get(slot) ?? null, write: async (slot: string, next: string) => { values.set(slot, next); }, remove: async (slot: string) => { values.delete(slot); } };
    const authority = createBrowserPolicyProfileAuthority(registry);
    const current = await authority.read();
    expect(current.kind).toBe('value');
    if (current.kind === 'value') expect(Object.keys(current.value)).toHaveLength(6);
  });
});
