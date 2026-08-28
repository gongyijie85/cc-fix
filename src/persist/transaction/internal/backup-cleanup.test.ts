// backup-cleanup 阶段机测试 — applying→删除→verified；失败→recovery_required

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TransactionJournalRepository } from '../../../state/journal.js';
import { convergeBackupCleanup } from './backup-cleanup.js';

async function createJournal() {
  const root = await mkdtemp(join(tmpdir(), 'cc-fix-cleanup-'));
  const repository = new TransactionJournalRepository(root, join(root, 'transaction-journal.json'));
  const journal = await repository.plan('protect', ['backup_cleanup']);
  return { root, repository, journal };
}

describe('convergeBackupCleanup', () => {
  it('applying → 删除快照 → verified', async () => {
    const { repository, journal } = await createJournal();
    const applying = await repository.transition(journal, 'backup_cleanup', 'applying');
    const deleteDailySnapshot = vi.fn(async () => undefined);
    const outcome = await convergeBackupCleanup({
      journal: applying,
      journalRepository: repository,
      deleteDailySnapshot,
    });
    expect(outcome.kind).toBe('verified');
    expect(deleteDailySnapshot).toHaveBeenCalledTimes(1);
    expect((await repository.read())?.steps.find((step) => step.id === 'backup_cleanup')?.phase).toBe('verified');
  });

  it('已 verified 时跳过删除步骤', async () => {
    const { repository, journal } = await createJournal();
    const applying = await repository.transition(journal, 'backup_cleanup', 'applying');
    const verifiedJournal = await repository.transition(applying, 'backup_cleanup', 'verified');
    const deleteDailySnapshot = vi.fn(async () => undefined);
    const outcome = await convergeBackupCleanup({
      journal: verifiedJournal,
      journalRepository: repository,
      deleteDailySnapshot,
    });
    expect(outcome.kind).toBe('verified');
    expect(deleteDailySnapshot).not.toHaveBeenCalled();
  });

  it('未注入删除后端时直接推进到 verified', async () => {
    const { repository, journal } = await createJournal();
    const applying = await repository.transition(journal, 'backup_cleanup', 'applying');
    const outcome = await convergeBackupCleanup({ journal: applying, journalRepository: repository });
    expect(outcome.kind).toBe('verified');
  });

  it('删除失败 → recovery_required 且 journal 落盘', async () => {
    const { repository, journal } = await createJournal();
    const applying = await repository.transition(journal, 'backup_cleanup', 'applying');
    const outcome = await convergeBackupCleanup({
      journal: applying,
      journalRepository: repository,
      deleteDailySnapshot: async () => { throw new Error('delete failed'); },
    });
    expect(outcome.kind).toBe('recovery_required');
    expect(outcome.journal).toBeDefined();
    expect((await repository.read())?.steps.find((step) => step.id === 'backup_cleanup')?.phase).toBe('recovery_required');
  });

  it('先决条件断言失败 → recovery_required', async () => {
    const { repository, journal } = await createJournal();
    const applying = await repository.transition(journal, 'backup_cleanup', 'applying');
    const outcome = await convergeBackupCleanup({
      journal: applying,
      journalRepository: repository,
      assertPreconditions: () => { throw new Error('precondition broken'); },
    });
    expect(outcome.kind).toBe('recovery_required');
  });
});
