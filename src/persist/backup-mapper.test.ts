import { describe, expect, it } from 'vitest';
import { storedMissing, storedValue } from '../state/schema.js';
import { backupSnapshotToDailyValues, createBackupSnapshotV4 } from './backup-mapper.js';

describe('daily backup mapper', () => {
  it('maps all six authority profiles into a complete schema-v4 snapshot', () => {
    const browser = Object.fromEntries(['chrome.accept_language','chrome.webrtc','chrome.application_locale','edge.accept_language','edge.webrtc','edge.application_locale'].map((id, index) => [id, index === 0 ? null : 'old']));
    const snapshot = createBackupSnapshotV4({
      environment: storedValue({ TZ: null, LANG: '', LC_ALL: 'old' }), system_timezone: storedValue('Old Zone'), browser_policies: storedValue(browser),
      locale_name: storedMissing(), user_languages: storedValue([]), user_culture: storedValue('zh-CN'),
    }, '2026-08-13T00:00:00.000Z', '7f60ed4b-bd54-4f9e-8c4c-c628a94b02a0');
    expect(snapshot.complete).toBe(true);
    expect(snapshot.authorities.environment.LANG).toEqual(storedValue(''));
    expect(snapshot.authorities.browserPolicies['chrome.accept_language'].value).toEqual(storedMissing());
    expect(snapshot.authorities.userLanguageList).toEqual(storedValue([]));
    expect(backupSnapshotToDailyValues(snapshot)).toEqual({
      environment: storedValue({ TZ: null, LANG: '', LC_ALL: 'old' }),
      system_timezone: storedValue('Old Zone'),
      browser_policies: storedValue(browser),
      locale_name: storedMissing(),
      user_languages: storedValue([]),
      user_culture: storedValue('zh-CN'),
    });
  });

  it.each([
    ['environment', storedMissing()],
    ['browser_policies', storedValue(null)],
  ])('rejects an incomplete %s profile', (id, invalid) => {
    const values = {
      environment: storedValue({ TZ: null, LANG: null, LC_ALL: null }),
      system_timezone: storedMissing(),
      browser_policies: storedValue(Object.fromEntries(['chrome.accept_language','chrome.webrtc','chrome.application_locale','edge.accept_language','edge.webrtc','edge.application_locale'].map((slot) => [slot, null]))),
      locale_name: storedMissing(), user_languages: storedMissing(), user_culture: storedMissing(),
    };
    values[id as 'environment' | 'browser_policies'] = invalid as never;
    expect(() => createBackupSnapshotV4(values, '2026-08-13T00:00:00.000Z', '7f60ed4b-bd54-4f9e-8c4c-c628a94b02a0')).toThrow(/incomplete/i);
  });

  it('rejects invalid snapshots and unsupported browser registry types', () => {
    expect(() => backupSnapshotToDailyValues({ schemaVersion: 5 } as never)).toThrow(/schema v4/i);
    const base = createBackupSnapshotV4({
      environment: storedValue({ TZ: null, LANG: null, LC_ALL: null }), system_timezone: storedMissing(),
      browser_policies: storedValue(Object.fromEntries(['chrome.accept_language','chrome.webrtc','chrome.application_locale','edge.accept_language','edge.webrtc','edge.application_locale'].map((slot) => [slot, null]))),
      locale_name: storedMissing(), user_languages: storedMissing(), user_culture: storedMissing(),
    }, '2026-08-13T00:00:00.000Z', '7f60ed4b-bd54-4f9e-8c4c-c628a94b02a0');
    const changed = structuredClone(base);
    changed.authorities.browserPolicies['chrome.accept_language'].value = storedValue({ registryType: 'REG_DWORD', value: 1 });
    expect(() => backupSnapshotToDailyValues(changed)).toThrow(/unsupported.*registry type/i);
  });
});
