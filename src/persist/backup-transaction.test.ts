import { describe, expect, it } from 'vitest';
import type { BackupRepository } from '../state/repository.js';
import { storedMissing, storedValue } from '../state/schema.js';
import { createRepositoryDailySnapshot } from './backup-transaction.js';

describe('repository daily snapshot', () => {
  it('creates one complete v4 snapshot through the immutable repository boundary', async () => {
    let captured: unknown;
    const repository = { create: async (snapshot: unknown) => { captured = snapshot; } } as unknown as BackupRepository;
    const browser = Object.fromEntries(['chrome.accept_language','chrome.webrtc','chrome.application_locale','edge.accept_language','edge.webrtc','edge.application_locale'].map((id) => [id, null]));
    await createRepositoryDailySnapshot(repository, () => '2026-08-13T00:00:00.000Z', () => '7f60ed4b-bd54-4f9e-8c4c-c628a94b02a0')({
      environment: storedValue({ TZ: null, LANG: null, LC_ALL: null }), system_timezone: storedValue('Old'), browser_policies: storedValue(browser), locale_name: storedMissing(), user_languages: storedValue([]), user_culture: storedMissing(),
    });
    expect(captured).toMatchObject({ schemaVersion: 4, complete: true, snapshotId: '7f60ed4b-bd54-4f9e-8c4c-c628a94b02a0' });
  });
});
