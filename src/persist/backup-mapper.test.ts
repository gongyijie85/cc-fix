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
});
