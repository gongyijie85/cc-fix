import { TransactionJournalRepository, type TransactionJournal } from '../../../state/journal.js';

export type BackupCleanupOutcome =
  | { kind: 'verified'; journal: TransactionJournal }
  | { kind: 'recovery_required'; journal: TransactionJournal | undefined };

/**
 * 共享的 journaled backup-cleanup 阶段机（ADR-0012 T-a）：
 * applying → 删除不可变日常快照 → verified；任一失败 → recovery_required。
 * 调用方各自的先决条件（verified 却备份仍在、缺少删除后端等）经 assertPreconditions
 * 与 deleteDailySnapshot 注入；恢复与日常还原共用同一台机器。
 */
export async function convergeBackupCleanup(input: {
  journal: TransactionJournal;
  journalRepository: TransactionJournalRepository;
  /** 备份仍存在时执行删除；备份已缺失时传 undefined（跳过删除步骤）。 */
  deleteDailySnapshot?: () => Promise<void>;
  /** 进入清理前的调用方不变量；抛错即进入 recovery_required 分支。 */
  assertPreconditions?(): void;
}): Promise<BackupCleanupOutcome> {
  let current = input.journal;
  try {
    input.assertPreconditions?.();
    const phase = current.steps.find((step) => step.id === 'backup_cleanup')?.phase;
    if (phase !== 'verified') {
      if (phase !== 'applying') current = await input.journalRepository.transition(current, 'backup_cleanup', 'applying');
      if (input.deleteDailySnapshot !== undefined) await input.deleteDailySnapshot();
      const latest = await input.journalRepository.read();
      if (latest === undefined) throw new Error('Journal disappeared during backup cleanup');
      current = latest;
      const after = latest.steps.find((step) => step.id === 'backup_cleanup')?.phase;
      if (after !== 'verified') current = await input.journalRepository.transition(latest, 'backup_cleanup', 'verified');
    }
    return { kind: 'verified', journal: current };
  } catch {
    const latest = await input.journalRepository.read();
    if (latest === undefined) return { kind: 'recovery_required', journal: undefined };
    const latestPhase = latest.steps.find((step) => step.id === 'backup_cleanup')?.phase;
    if (latestPhase !== 'recovery_required') {
      try { await input.journalRepository.transition(latest, 'backup_cleanup', 'recovery_required'); } catch {}
    }
    return { kind: 'recovery_required', journal: latest };
  }
}