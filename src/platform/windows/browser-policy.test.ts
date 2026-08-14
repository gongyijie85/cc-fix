import { describe, expect, it } from 'vitest';
import { storedMissing, storedValue, desiredBrowserPolicies } from '../../state/schema.js';
import { createBrowserPolicyProfileAuthority } from './browser-policy.js';
import type { BrowserPolicySlotId } from '../../state/schema.js';

describe('browser policy authority', () => {
  it('captures all six policy slots as one compensated profile', async () => {
    const values = new Map<string, string>();
    const registry = { read: async (slot: BrowserPolicySlotId) => values.get(slot) ?? null, write: async (slot: BrowserPolicySlotId, next: string) => { values.set(slot, next); return 'written' as const; }, remove: async (slot: BrowserPolicySlotId) => { values.delete(slot); } };
    const authority = createBrowserPolicyProfileAuthority(registry);
    const current = await authority.read();
    expect(current.kind).toBe('value');
    if (current.kind === 'value') expect(Object.keys(current.value)).toHaveLength(6);
  });

  it('writes catalogue-derived desired values in the slot-id vocabulary（ADR-0011 回归：曾 INVALID_VALUE 永久回滚）', async () => {
    const values = new Map<string, string>();
    const registry = { read: async (slot: BrowserPolicySlotId) => values.get(slot) ?? null, write: async (slot: BrowserPolicySlotId, next: string) => { values.set(slot, next); return 'written' as const; }, remove: async (slot: BrowserPolicySlotId) => { values.delete(slot); } };
    const authority = createBrowserPolicyProfileAuthority(registry);
    const desired = desiredBrowserPolicies('en_US.UTF-8');
    const outcome = await authority.write(storedValue(desired));
    expect(outcome).toBeUndefined();
    expect(values.get('chrome.accept_language')).toBe('en-US,en');
    expect(values.get('edge.webrtc')).toBe('disable_non_proxied_udp');
    expect(values.size).toBe(6);
  });

  it('reports per-slot denials while keeping the written subset（ADR-0011 T2）', async () => {
    const values = new Map<string, string>();
    const registry = {
      read: async (slot: BrowserPolicySlotId) => values.get(slot) ?? null,
      write: async (slot: BrowserPolicySlotId, next: string) => {
        if (slot === 'chrome.webrtc') return 'access_denied' as const;
        values.set(slot, next);
        return 'written' as const;
      },
      remove: async (slot: BrowserPolicySlotId) => { values.delete(slot); },
    };
    const authority = createBrowserPolicyProfileAuthority(registry);
    const outcome = await authority.write(storedValue(desiredBrowserPolicies('en_US.UTF-8')));
    expect(outcome).toEqual({ unaligned: [{ kind: 'browser_policy_unaligned', slot: 'chrome.webrtc', cause: 'access_denied' }] });
    expect(values.get('chrome.accept_language')).toBe('en-US,en');
    expect(values.has('chrome.webrtc')).toBe(false);
    expect(values.size).toBe(5);
  });

  it('restores missing slots by removal and reads back a six-null profile', async () => {
    const values = new Map<string, string>([['chrome.webrtc', 'disable_non_proxied_udp']]);
    const registry = { read: async (slot: BrowserPolicySlotId) => values.get(slot) ?? null, write: async (slot: BrowserPolicySlotId, next: string) => { values.set(slot, next); return 'written' as const; }, remove: async (slot: BrowserPolicySlotId) => { values.delete(slot); } };
    const authority = createBrowserPolicyProfileAuthority(registry);
    await authority.write(storedMissing());
    expect(values.size).toBe(0);
    const after = await authority.read();
    expect(after.kind).toBe('value');
    if (after.kind === 'value') {
      expect(Object.values(after.value)).toEqual([null, null, null, null, null, null]);
    }
  });
});
