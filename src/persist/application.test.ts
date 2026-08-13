import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupRepository, StateRepository } from '../state/repository.js';
import { InProcessTestMutationCoordinator } from '../state/test-support/in-process-mutation-coordinator.js';
import { TransactionJournalRepository } from '../state/journal.js';
import { statePaths } from '../state/paths.js';
import { storedValue, type StoredValue } from '../state/schema.js';
import type { JsonValue } from '../state/checksum.js';
import type { PersistStepId } from './steps.js';
import { desiredValues } from './targets.js';
import { createBackupSnapshotV4 } from './backup-mapper.js';
import { PersistApplicationError, PersistApplicationService } from './application.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function dailyValues(): Record<PersistStepId, StoredValue<JsonValue>> {
  return {
    environment: storedValue({ TZ: null, LANG: null, LC_ALL: null }),
    system_timezone: storedValue('China Standard Time'),
    browser_policies: storedValue(Object.fromEntries([
      'chrome.accept_language','chrome.webrtc','chrome.application_locale',
      'edge.accept_language','edge.webrtc','edge.application_locale',
    ].map((id) => [id, null]))),
    locale_name: storedValue('zh-CN'),
    user_languages: storedValue(['zh-CN', 'en-US']),
    user_culture: storedValue('zh-CN'),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cc-fix-application-'));
  roots.push(root);
  const testCoordinator = new InProcessTestMutationCoordinator();
  const stateRepository = new StateRepository({ root, mutationCoordinator: testCoordinator.capability });
  const backupRepository = new BackupRepository({ root, mutationCoordinator: testCoordinator.capability });
  await stateRepository.initialize('us');
  const current = new Map<PersistStepId, StoredValue<JsonValue>>(Object.entries(dailyValues()) as Array<[PersistStepId, StoredValue<JsonValue>]>);
  const writes: PersistStepId[] = [];
  const authorities = Object.fromEntries([...current.keys()].map((id) => [id, {
    read: async () => current.get(id)!,
    write: async (value: StoredValue<JsonValue>) => { writes.push(id); current.set(id, value); },
  }])) as Record<PersistStepId, { read(): Promise<StoredValue<JsonValue>>; write(value: StoredValue<JsonValue>): Promise<void> }>;
  const service = new PersistApplicationService({
    root,
    coordinator: testCoordinator.capability,
    stateRepository,
    backupRepository,
    journalRepository: new TransactionJournalRepository(root, statePaths(root).journal),
    authorities,
    now: () => '2026-08-13T00:00:00.000Z',
    snapshotId: () => '7f60ed4b-bd54-4f9e-8c4c-c628a94b02a0',
  });
  return { root, stateRepository, backupRepository, current, writes, service };
}

describe('persist application service', () => {
  it('owns the complete root-locked backup, journal, authority and state commit path', async () => {
    const subject = await fixture();
    await expect(subject.service.protect({ mode: 'standard', region: 'us' })).resolves.toMatchObject({ kind: 'committable' });
    expect((await subject.stateRepository.read()).value).toMatchObject({
      committedTarget: { mode: 'standard', region: 'us' }, activeTransactionId: null, health: 'healthy',
    });
    expect((await subject.backupRepository.read()).kind).toBe('value');
    expect(subject.writes).toEqual(['environment', 'system_timezone', 'browser_policies']);
  });

  it('reuses an exact residual daily backup after a pre-write failure', async () => {
    const subject = await fixture();
    await subject.backupRepository.create(createBackupSnapshotV4(
      dailyValues(), '2026-08-13T00:00:00.000Z', '7f60ed4b-bd54-4f9e-8c4c-c628a94b02a0',
    ));
    await expect(subject.service.protect({ mode: 'standard', region: 'jp' })).resolves.toMatchObject({ kind: 'committable' });
    expect((await subject.stateRepository.read()).value.committedTarget).toEqual({ mode: 'standard', region: 'jp' });
  });

  it('fails closed when a residual backup no longer matches daily authorities', async () => {
    const subject = await fixture();
    await subject.backupRepository.create(createBackupSnapshotV4(
      dailyValues(), '2026-08-13T00:00:00.000Z', '7f60ed4b-bd54-4f9e-8c4c-c628a94b02a0',
    ));
    subject.current.set('locale_name', storedValue('en-US'));
    await expect(subject.service.protect({ mode: 'standard', region: 'us' })).rejects.toMatchObject({
      code: 'BACKUP_CONFLICT',
    } satisfies Partial<PersistApplicationError>);
    expect(subject.writes).toEqual([]);
    expect((await subject.stateRepository.read()).value.committedTarget).toBeNull();
  });

  it('uses the daily snapshot when reducing deep protection to standard', async () => {
    const subject = await fixture();
    await subject.service.protect({ mode: 'deep', region: 'jp' });
    expect(subject.current.get('locale_name')).toEqual(desiredValues({ mode: 'deep', region: 'jp' }).locale_name);
    subject.writes.length = 0;
    await subject.service.protect({ mode: 'standard', region: 'jp' });
    expect(subject.current.get('locale_name')).toEqual(dailyValues().locale_name);
    expect(subject.writes).toEqual(['locale_name', 'user_languages', 'user_culture']);
  });
});
