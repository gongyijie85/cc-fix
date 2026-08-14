import type { JsonValue } from '../state/checksum.js';
import type { DegradationReason, StoredValue } from '../state/schema.js';
import type { PersistStepId } from './steps.js';

/**
 * 权威存储写入结果（ADR-0011 / ADR-0012 公开 seam）：
 * undefined = 全部写入并验证；结构化结果 = 部分策略槽被拒、已写槽保留。
 */
export type WriteOutcome = Readonly<{ unaligned: readonly DegradationReason[] }> | void;

/** 单个受管用户/系统设置的读写契约；平台适配器在此 seam 上实现。 */
export interface ExecutableAuthority {
  read(): Promise<StoredValue<JsonValue>>;
  write(value: StoredValue<JsonValue>): Promise<WriteOutcome>;
}

/** 执行期日志上报（事务日志阶段机的写入侧）。 */
export interface ExecutionJournal {
  transition(id: PersistStepId, phase: 'applying' | 'verified' | 'compensating' | 'compensated' | 'recovery_required'): Promise<void>;
}
