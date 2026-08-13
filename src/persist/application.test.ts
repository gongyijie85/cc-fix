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
  const deletedSnapshots: string[] = [];
  let deleteFails = false;
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
    deleteDailySnapshot: async (snapshot) => {
      if (deleteFails) throw new Error('injected native delete failure');
      deletedSnapshots.push(snapshot.snapshotId);
    },
  });
  const serviceWithoutDelete = new PersistApplicationService({
    root, coordinator: testCoordinator.capability, stateRepository, backupRepository,
    journalRepository: new TransactionJournalRepository(root, statePaths(root).journal), authorities,
  });
  return {
    root, testCoordinator, stateRepository, backupRepository,
    journalRepository: new TransactionJournalRepository(root, statePaths(root).journal),
    current, writes, deletedSnapshots, authorities, service, serviceWithoutDelete,
    setDeleteFailure(value: boolean) { deleteFails = value; },
  };
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

  it('restores every authority, publishes daily, then invokes verified backup cleanup', async () => {
    const subject = await fixture();
    await subject.service.protect({ mode: 'deep', region: 'sg' });
    subject.writes.length = 0;
    await expect(subject.service.restore()).resolves.toEqual({ kind: 'restored' });
    expect(subject.writes).toEqual([
      'environment', 'system_timezone', 'browser_policies', 'locale_name', 'user_languages', 'user_culture',
    ]);
    expect((await subject.stateRepository.read()).value).toMatchObject({
      committedTarget: null, activeTransactionId: null, health: 'healthy',
    });
    expect(subject.deletedSnapshots).toEqual(['7f60ed4b-bd54-4f9e-8c4c-c628a94b02a0']);
  });

  it('reverse-compensates a crashed protect transaction using durable journal context', async () => {
    const subject = await fixture();
    const daily = dailyValues();
    const target = desiredValues({ mode: 'standard', region: 'us' });
    let journal = await subject.journalRepository.plan('protect', [
      { id: 'environment', original: daily.environment, desired: target.environment },
      { id: 'system_timezone', original: daily.system_timezone, desired: target.system_timezone },
    ], {
      previousState: { committedTarget: null, preferredRegion: 'us', health: 'healthy', degradation: [] },
      requestedTarget: { mode: 'standard', region: 'us' },
    });
    await subject.stateRepository.commit(0, {
      committedTarget: null, preferredRegion: 'us', health: 'healthy', degradation: [], activeTransactionId: journal.transactionId,
    });
    journal = await subject.journalRepository.transition(journal, 'environment', 'applying');
    subject.current.set('environment', target.environment);
    await subject.journalRepository.transition(journal, 'environment', 'verified');
    await expect(subject.service.recover()).resolves.toEqual({ kind: 'recovered', failed: [] });
    expect(subject.current.get('environment')).toEqual(daily.environment);
    expect((await subject.stateRepository.read()).value).toMatchObject({ committedTarget: null, activeTransactionId: null, health: 'healthy' });
  });

  it('does not replay a completed historical journal', async () => {
    const subject = await fixture();
    await subject.service.protect({ mode: 'standard', region: 'us' });
    const before = (await subject.stateRepository.read()).value.revision;
    subject.writes.length = 0;
    await expect(subject.service.recover()).resolves.toEqual({ kind: 'noop', failed: [] });
    expect(subject.writes).toEqual([]);
    expect((await subject.stateRepository.read()).value.revision).toBe(before);
  });

  it('treats restoring an idle daily state as a no-op', async () => {
    const subject = await fixture();
    await expect(subject.service.restore()).resolves.toEqual({ kind: 'noop' });
  });

  it('fails closed when protected state has no daily backup', async () => {
    const subject = await fixture();
    await subject.stateRepository.commit(0, {
      committedTarget: { mode: 'deep', region: 'us' }, preferredRegion: 'us', health: 'healthy', degradation: [], activeTransactionId: null,
    });
    await expect(subject.service.restore()).rejects.toMatchObject({ code: 'BACKUP_REQUIRED' });
    await expect(subject.service.protect({ mode: 'standard', region: 'us' })).rejects.toMatchObject({ code: 'BACKUP_REQUIRED' });
  });

  it('requires the verified native delete backend before restoring', async () => {
    const subject = await fixture();
    await subject.service.protect({ mode: 'standard', region: 'us' });
    await expect(subject.serviceWithoutDelete.restore()).rejects.toMatchObject({ code: 'DELETE_BACKEND_REQUIRED' });
  });

  it('blocks new protect and restore requests while state reconciliation is active', async () => {
    const subject = await fixture();
    await subject.stateRepository.commit(0, {
      committedTarget: { mode: 'standard', region: 'us' }, preferredRegion: 'us', health: 'healthy', degradation: [], activeTransactionId: '2d6b94e4-89a2-4a80-a827-6c2e230f66aa',
    });
    await expect(subject.service.protect({ mode: 'standard', region: 'jp' })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await expect(subject.service.restore()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await expect(subject.service.recover()).rejects.toMatchObject({ code: 'RECOVERY_CONTEXT_INVALID' });
  });

  it('records failed protect recovery and preserves the previous committed target', async () => {
    const subject = await fixture();
    const daily = dailyValues();
    const target = desiredValues({ mode: 'standard', region: 'us' });
    let journal = await subject.journalRepository.plan('protect', [{ id: 'environment', original: daily.environment, desired: target.environment }], {
      previousState: { committedTarget: null, preferredRegion: 'us', health: 'degraded', degradation: [{ kind: 'browser_policy_unaligned', slot: 'chrome.accept_language', cause: 'access_denied' }] },
      requestedTarget: { mode: 'standard', region: 'us' },
    });
    await subject.stateRepository.commit(0, {
      committedTarget: null, preferredRegion: 'us', health: 'healthy', degradation: [], activeTransactionId: journal.transactionId,
    });
    journal = await subject.journalRepository.transition(journal, 'environment', 'applying');
    await subject.journalRepository.transition(journal, 'environment', 'verified');
    subject.authorities.environment.write = async () => { throw new Error('injected compensation failure'); };
    await expect(subject.service.recover()).resolves.toEqual({ kind: 'recovery_required', failed: ['environment'] });
    expect((await subject.stateRepository.read()).value.health).toBe('recovery_required');
  });

  it('retries a failed restore cleanup and converges to daily', async () => {
    const subject = await fixture();
    await subject.service.protect({ mode: 'standard', region: 'sg' });
    subject.setDeleteFailure(true);
    await expect(subject.service.restore()).resolves.toMatchObject({ kind: 'recovery_required' });
    subject.setDeleteFailure(false);
    await expect(subject.service.recover()).resolves.toEqual({ kind: 'recovered', failed: [] });
    expect((await subject.stateRepository.read()).value).toMatchObject({ committedTarget: null, health: 'healthy', activeTransactionId: null });
  });

  it('rejects a recovery journal without committed context', async () => {
    const subject = await fixture();
    const journal = await subject.journalRepository.plan('protect', [{ id: 'environment', original: dailyValues().environment }]);
    await subject.stateRepository.commit(0, {
      committedTarget: null, preferredRegion: 'us', health: 'healthy', degradation: [], activeTransactionId: journal.transactionId,
    });
    await expect(subject.service.recover()).rejects.toMatchObject({ code: 'RECOVERY_CONTEXT_INVALID' });
  });
});
