import { describe, expect, it } from 'vitest';
import { desiredValues } from './targets.js';
import { createBackupSnapshotV4, backupSnapshotToDailyValues } from './backup-mapper.js';
import { BROWSER_POLICY_SLOTS, storedValueEquals } from '../state/schema.js';

describe('target values', () => {
  it('derives only catalogued authority values without network settings', () => {
    const values = desiredValues({ mode: 'deep', region: 'jp' });
    expect(values.system_timezone).toMatchObject({ value: 'Tokyo Standard Time' });
    expect(values.user_languages).toMatchObject({ value: ['ja-JP'] });
    expect(JSON.stringify(values)).not.toMatch(/vpn|route|adapter|host|doh|dns/i);
  });

  it('browser_policies 期望值使用槽 id 词汇，与目录完全一致（ADR-0011 回归）', () => {
    for (const mode of ['standard', 'deep'] as const) {
      const desired = desiredValues({ mode, region: 'us' });
      const policies = desired.browser_policies;
      if (policies.kind !== 'value') throw new Error('browser_policies must be a value');
      expect(Object.keys(policies.value).sort()).toEqual(BROWSER_POLICY_SLOTS.map((slot) => slot.id).sort());
      expect(policies.value['chrome.accept_language']).toBe('en-US,en');
      expect(policies.value['chrome.webrtc']).toBe('disable_non_proxied_udp');
      expect(policies.value['edge.application_locale']).toBe('en-US');
    }
  });

  it('期望值经备份快照 v4 往返后逐槽还原（检测 → persist → 备份同一词汇）', () => {
    const desired = desiredValues({ mode: 'deep', region: 'jp' });
    const snapshot = createBackupSnapshotV4(desired, '2026-08-11T00:00:00.000Z', '123e4567-e89b-12d3-a456-426614174000');
    const daily = backupSnapshotToDailyValues(snapshot);
    const policies = desired.browser_policies;
    const dailyPolicies = daily.browser_policies;
    if (policies.kind !== 'value' || dailyPolicies.kind !== 'value') throw new Error('browser_policies must be values');
    expect(storedValueEquals(policies, dailyPolicies)).toBe(true);
    expect(dailyPolicies.value['chrome.accept_language']).toBe('ja-JP,ja');
    expect(dailyPolicies.value['chrome.webrtc']).toBe('disable_non_proxied_udp');
    expect(dailyPolicies.value['edge.application_locale']).toBe('ja-JP');
  });
});
