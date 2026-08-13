import { BROWSER_POLICY_SLOTS, type BrowserPolicySlotId } from '../../state/schema.js';
import { createWindowsAuthority, type WindowsAuthority } from './authority.js';
import { PolicyManagedOrDeniedError } from '../../persist/executor.js';

export interface BrowserPolicyRegistry { read(slot: BrowserPolicySlotId): Promise<string | null>; write(slot: BrowserPolicySlotId, value: string): Promise<void>; remove(slot: BrowserPolicySlotId): Promise<void>; }
const ids = new Set<BrowserPolicySlotId>(BROWSER_POLICY_SLOTS.map((slot) => slot.id));
export function createBrowserPolicyAuthority(registry: BrowserPolicyRegistry, slot: BrowserPolicySlotId): WindowsAuthority<string> {
  if (!ids.has(slot)) throw new Error('Unmanaged browser policy slot');
  return createWindowsAuthority(`browser_policy.${slot}`, { readRaw: () => registry.read(slot), writeRaw: async (value) => {
    try { await registry.write(slot, value); } catch (error) { if (error instanceof PolicyManagedOrDeniedError) throw error; throw error; }
  }, removeRaw: () => registry.remove(slot), validate: (value): value is string => typeof value === 'string' });
}

export type BrowserPolicyProfile = Record<BrowserPolicySlotId, string | null>;
export function createBrowserPolicyProfileAuthority(registry: BrowserPolicyRegistry): WindowsAuthority<BrowserPolicyProfile> {
  const slotIds = BROWSER_POLICY_SLOTS.map((slot) => slot.id);
  return createWindowsAuthority('browser_policies', {
    readRaw: async () => Object.fromEntries(await Promise.all(slotIds.map(async (id) => [id, await registry.read(id)]))) as BrowserPolicyProfile,
    writeRaw: async (value) => { for (const id of slotIds) { const next = value[id]; if (next === null) await registry.remove(id); else await registry.write(id, next); } },
    removeRaw: async () => { for (const id of slotIds) await registry.remove(id); },
    validate: (value): value is BrowserPolicyProfile => typeof value === 'object' && value !== null && !Array.isArray(value) && slotIds.every((id) => typeof (value as Record<string, unknown>)[id] === 'string' || (value as Record<string, unknown>)[id] === null) && Object.keys(value).length === slotIds.length,
  });
}
