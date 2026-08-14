import {
  BROWSER_POLICY_SLOTS,
  storedValue,
  type BrowserPolicySlotId,
  type DegradationReason,
  type StoredValue,
} from '../../state/schema.js';
import type { ExecutableAuthority, WriteOutcome } from '../../persist/authority.js';

export type BrowserPolicyProfile = Record<BrowserPolicySlotId, string | null>;
export type BrowserPolicyWriteResult = 'written' | 'access_denied';

export interface BrowserPolicyRegistry {
  read(slot: BrowserPolicySlotId): Promise<string | null>;
  /** 写入单槽；访问被拒时返回 access_denied 而非抛出（每槽粒度，ADR-0011）。 */
  write(slot: BrowserPolicySlotId, value: string): Promise<BrowserPolicyWriteResult>;
  remove(slot: BrowserPolicySlotId): Promise<void>;
}

const slotIds = BROWSER_POLICY_SLOTS.map((slot) => slot.id);

function isBrowserPolicyProfile(value: unknown): value is BrowserPolicyProfile {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === slotIds.length
    && slotIds.every((id) => typeof (value as Record<string, unknown>)[id] === 'string' || (value as Record<string, unknown>)[id] === null);
}

/**
 * 六槽复合 authority：按槽写入并逐槽验证；被拒槽记录为 unaligned（已写槽保留），
 * 其余槽仍执行写入 + 读回验证（ADR-0006 的验证后提交保留给已写子集）。
 */
export function createBrowserPolicyProfileAuthority(registry: BrowserPolicyRegistry): ExecutableAuthority {
  return Object.freeze({
    read: async (): Promise<StoredValue<BrowserPolicyProfile>> => {
      const profile = Object.fromEntries(await Promise.all(slotIds.map(async (id) => [id, await registry.read(id)]))) as BrowserPolicyProfile;
      if (!isBrowserPolicyProfile(profile)) throw new Error('Invalid browser policy profile read');
      return storedValue(profile);
    },
    write: async (value: StoredValue<BrowserPolicyProfile>): Promise<WriteOutcome> => {
      if (value.kind === 'missing') {
        for (const id of slotIds) await registry.remove(id);
        return;
      }
      if (!isBrowserPolicyProfile(value.value)) throw new Error('Invalid browser policy profile for write');
      const unaligned: DegradationReason[] = [];
      for (const id of slotIds) {
        const next = value.value[id];
        if (next === null) { await registry.remove(id); continue; }
        const outcome = await registry.write(id, next);
        if (outcome === 'access_denied') {
          unaligned.push(Object.freeze({ kind: 'browser_policy_unaligned', slot: id, cause: 'access_denied' }));
          continue;
        }
        const actual = await registry.read(id);
        if (actual !== next) throw new Error(`Readback mismatch for browser policy ${id}`);
      }
      return unaligned.length === 0 ? undefined : Object.freeze({ unaligned });
    },
  });
}
