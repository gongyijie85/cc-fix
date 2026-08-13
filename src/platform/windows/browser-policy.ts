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
