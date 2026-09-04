import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionJournalRepository } from '../../state/journal.js';
import { statePaths } from '../../state/paths.js';
import { StateRepository, BackupRepository } from '../../state/repository.js';
import { InProcessTestMutationCoordinator } from '../../state/test-support/in-process-mutation-coordinator.js';
import { storedValue } from '../../state/schema.js';
import { createPersistTransactionModule, PersistApplicationError } from './index.js';
import { STANDARD_STEP_IDS, DEEP_ONLY_STEP_IDS, type PersistStepId } from '../steps.js';

// #116：日常态偏好地区更新的服务层契约（updated/noop/拒绝矩阵）。
async function fixtureModule() {
  const root = await mkdtemp(join(tmpdir(), 'cc-fix-preferred-region-'));
  await mkdir(root, { recursive: true });
  const coordinator = new InProcessTestMutationCoordinator();
  const stateRepository = new StateRepository({ root, mutationCoordinator: coordinator.capability });
  const backupRepository = new BackupRepository({ root, mutationCoordinator: coordinator.capability });
  const journalRepository = new TransactionJournalRepository(root, statePaths(root).journal);
  const authorities = Object.fromEntries(
    [...STANDARD_STEP_IDS, ...DEEP_ONLY_STEP_IDS].map((id) => [
      id,
      { read: async () => storedValue(`value-${id}`), write: async () => undefined },
    ]),
  ) as Readonly<Record<PersistStepId, { read: () => Promise<unknown>; write: () => Promise<void> }>> as never;
  const module = createPersistTransactionModule({
    root,
    coordinator: coordinator.capability,
    stateRepository,
    backupRepository,
    journalRepository,
    authorities,
  });
  return { root, module, stateRepository };
}

describe('setPreferredRegion (issue #116)', () => {
  it('updates the preferred region in daily mode and bumps the revision', async () => {
    const { root, module, stateRepository } = await fixtureModule();
    try {
      await stateRepository.initialize('us');
      const result = await module.setPreferredRegion('jp');
      expect(result).toEqual({ kind: 'updated', preferredRegion: 'jp' });
      const after = await stateRepository.read();
      expect(after.value.preferredRegion).toBe('jp');
      expect(after.value.revision).toBe(1);
      expect(after.value.committedTarget).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is a revision-neutral no-op when the region is unchanged', async () => {
    const { root, module, stateRepository } = await fixtureModule();
    try {
      await stateRepository.initialize('sg');
      const result = await module.setPreferredRegion('sg');
      expect(result).toEqual({ kind: 'noop', preferredRegion: 'sg' });
      expect((await stateRepository.read()).value.revision).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses the update while a protection target is committed', async () => {
    const { root, module, stateRepository } = await fixtureModule();
    try {
      await stateRepository.initialize('us');
      await stateRepository.commit(0, {
        committedTarget: { mode: 'standard', region: 'us' },
        preferredRegion: 'us',
        health: 'healthy',
        degradation: [],
        activeTransactionId: null,
      });
      await expect(module.setPreferredRegion('jp')).rejects.toMatchObject({
        code: 'REGION_SET_REQUIRES_DAILY',
      });
      await expect(module.setPreferredRegion('jp')).rejects.toBeInstanceOf(PersistApplicationError);
      expect((await stateRepository.read()).value.preferredRegion).toBe('us');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses the update while recovery is required or a transaction is active', async () => {
    const { root, module, stateRepository } = await fixtureModule();
    try {
      await stateRepository.initialize('us');
      await stateRepository.commit(0, {
        committedTarget: null,
        preferredRegion: 'us',
        health: 'recovery_required',
        degradation: [],
        activeTransactionId: 'tx-open',
      });
      await expect(module.setPreferredRegion('eu')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
