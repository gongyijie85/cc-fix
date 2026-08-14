import type { JsonValue } from '../../../state/checksum.js';
import { storedValueEquals, type StoredValue } from '../../../state/schema.js';
import type { PersistStepId } from '../../steps.js';
import type { ExecutableAuthority, ExecutionJournal } from './executor.js';

export type RestoreResult = Readonly<{ verified: readonly PersistStepId[]; failed: readonly PersistStepId[] }>;

/**
 * Converges toward the immutable daily snapshot.  Failure of one field never
 * prevents later fields from being restored or verified.
 */
export async function restoreAll(input: {
  order: readonly PersistStepId[];
  daily: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>;
  authorities: Readonly<Record<PersistStepId, ExecutableAuthority>>;
  journal: ExecutionJournal;
}): Promise<RestoreResult> {
  const verified: PersistStepId[] = [];
  const failed: PersistStepId[] = [];
  for (const id of input.order) {
    const outcome = await applyDailyStep({
      id,
      daily: input.daily[id],
      authority: input.authorities[id],
      write: true,
      beginTransition: () => input.journal.transition(id, 'applying'),
      reportVerified: () => input.journal.transition(id, 'verified'),
      reportFailure: async () => { try { await input.journal.transition(id, 'recovery_required'); } catch {} },
    });
    (outcome === 'verified' ? verified : failed).push(id);
  }
  return { verified, failed };
}

/**
 * 共享的收敛式恢复单步脚手架（评审候选 5）：写入（可选）→ 读回验证 → 阶段推进 → 失败收集
 * 在一处实现；fresh 与 crash-resume 两个调用方只保留各自的写入决策与阶段推进语义。
 */
export async function applyDailyStep(input: {
  id: PersistStepId;
  daily: StoredValue<JsonValue>;
  authority: ExecutableAuthority;
  /** false = 已对齐跳过写入（resume 策略）；true = 总是写入（fresh 策略）。 */
  write: boolean;
  beginTransition: () => Promise<void>;
  reportVerified: () => Promise<void>;
  reportFailure: () => Promise<void>;
}): Promise<'verified' | 'failed'> {
  try {
    // 阶段先推进（applying 幂等由调用方保证）：aligned 跳过写入的步骤也必须是
    // planned→applying→verified 合法链，否则崩溃恢复重试会卡在非法转移上。
    await input.beginTransition();
    if (input.write) {
      const outcome = await input.authority.write(input.daily);
      if (outcome !== undefined) throw new Error('Restore write denied on ' + input.id);
    }
    const actual = await input.authority.read();
    if (!storedValueEquals(actual, input.daily)) throw new Error('Restore readback mismatch');
    await input.reportVerified();
    return 'verified';
  } catch {
    await input.reportFailure();
    return 'failed';
  }
}
