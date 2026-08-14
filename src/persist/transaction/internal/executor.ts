import type { JsonValue } from '../../../state/checksum.js';
import type { StoredValue } from '../../../state/schema.js';
import type { PersistStepId, PlannedStep } from '../../steps.js';
import { ALL_STEP_IDS } from '../../steps.js';
import type { DegradationReason } from '../../../state/schema.js';

import type { ExecutableAuthority, ExecutionJournal } from '../../authority.js';
export type { ExecutableAuthority, ExecutionJournal, WriteOutcome } from '../../authority.js';
export type ExecutionResult =
  | Readonly<{ kind: 'committable'; degraded: readonly [] }>
  | Readonly<{ kind: 'degraded'; degraded: readonly DegradationReason[] }>
  | Readonly<{ kind: 'compensated' | 'recovery_required'; degraded: readonly [] }>;

/** Captures all originals before the first write so recovery has a complete plan. */
export async function captureJournalPlan(input: {
  steps: readonly PlannedStep[];
  desired: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>;
  authorities: Readonly<Record<PersistStepId, ExecutableAuthority>>;
}): Promise<readonly { id: PersistStepId; original: JsonValue; desired: JsonValue }[]> {
  const captured = [] as Array<{ id: PersistStepId; original: JsonValue; desired: JsonValue }>;
  for (const step of input.steps) {
    if (step.action === 'noop') continue;
    const original = await input.authorities[step.id].read();
    captured.push({ id: step.id, original: original as JsonValue, desired: input.desired[step.id] as JsonValue });
  }
  return captured;
}

export async function captureDailyAuthorityValues(
  authorities: Readonly<Record<PersistStepId, ExecutableAuthority>>,
): Promise<Readonly<Record<PersistStepId, StoredValue<JsonValue>>>> {
  const entries = await Promise.all(ALL_STEP_IDS.map(async (id) => [id, await authorities[id].read()] as const));
  return Object.freeze(Object.fromEntries(entries) as Record<PersistStepId, StoredValue<JsonValue>>);
}

/** Applies write/readback operations and compensates every modified authority in reverse order. */
export async function executePlan(input: {
  steps: readonly PlannedStep[];
  desired: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>;
  authorities: Readonly<Record<PersistStepId, ExecutableAuthority>>;
  journal: ExecutionJournal;
}): Promise<ExecutionResult> {
  const modified: Array<{ id: PersistStepId; original: StoredValue<JsonValue> }> = [];
  const degraded: DegradationReason[] = [];
  try {
    for (const step of input.steps) {
      if (step.action === 'noop') continue;
      const authority = input.authorities[step.id];
      const original = await authority.read();
      await input.journal.transition(step.id, 'applying');
      // A platform write may change state and then throw (or its readback may
      // fail). Record it before crossing that boundary so it is compensated.
      modified.push({ id: step.id, original });
      const outcome = await authority.write(input.desired[step.id]);
      if (outcome !== undefined) {
        // 每槽降级（ADR-0011 T2）：只有 planner 标记 degradable 的策略步可以携带拒绝结果；
        // 已写子集保留不补偿，未对齐槽逐槽记录，随后仍按步骤级 verified 提交。
        if (step.disposition !== 'degradable') throw new Error(`Unexpected write denials on required step: ${step.id}`);
        degraded.push(...outcome.unaligned);
        await input.journal.transition(step.id, 'verified');
        continue;
      }
      const actual = await authority.read();
      if (JSON.stringify(actual) !== JSON.stringify(input.desired[step.id])) throw new Error('Readback mismatch');
      await input.journal.transition(step.id, 'verified');
    }
    return degraded.length === 0
      ? { kind: 'committable', degraded: [] }
      : { kind: 'degraded', degraded };
  } catch {
    let incomplete = false;
    for (const entry of [...modified].reverse()) {
      try { await input.journal.transition(entry.id, 'compensating'); await input.authorities[entry.id].write(entry.original); await input.journal.transition(entry.id, 'compensated'); }
      catch { incomplete = true; try { await input.journal.transition(entry.id, 'recovery_required'); } catch {} }
    }
    return { kind: incomplete ? 'recovery_required' : 'compensated', degraded: [] };
  }
}