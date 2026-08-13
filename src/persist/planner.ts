import type { ProtectionTarget } from '../domain/protection.js';
import { ALL_STEP_IDS, DEEP_ONLY_STEP_IDS, managedStepIds, type PersistStepId, type PlannedStep } from './steps.js';

export type AuthorityObservation = Readonly<Partial<Record<PersistStepId, boolean>>>;
export type TransitionPlan = Readonly<{
  kind: 'protect' | 'restore' | 'noop';
  from: ProtectionTarget | null;
  target: ProtectionTarget | null;
  steps: readonly PlannedStep[];
}>;

function applyStep(id: PersistStepId, aligned: boolean | undefined): PlannedStep {
  if (aligned === true) return { id, disposition: 'skipped', action: 'noop' };
  return { id, disposition: id === 'browser_policies' ? 'degradable' : 'required', action: 'apply' };
}

/** Generates deterministic, write-free transition plans. No network setting exists in this vocabulary. */
export function planTransition(input: {
  committedTarget: ProtectionTarget | null;
  requestedTarget: ProtectionTarget | null;
  observed: AuthorityObservation;
}): TransitionPlan {
  const { committedTarget: from, requestedTarget: target, observed } = input;
  if (target === null) {
    if (from === null) return { kind: 'noop', from, target, steps: [] };
    return { kind: 'restore', from, target, steps: ALL_STEP_IDS.map((id) => ({ id, disposition: 'required', action: 'restore' })) };
  }
  const wanted = new Set(managedStepIds(target));
  const restoringDeep = from?.mode === 'deep' && target.mode === 'standard';
  const steps: PlannedStep[] = [];
  for (const id of ALL_STEP_IDS) {
    if (wanted.has(id)) steps.push(applyStep(id, observed[id]));
    else if (restoringDeep && DEEP_ONLY_STEP_IDS.includes(id as (typeof DEEP_ONLY_STEP_IDS)[number])) {
      steps.push({ id, disposition: 'required', action: 'restore' });
    }
  }
  const sameTarget = from?.mode === target.mode && from.region === target.region;
  const kind = sameTarget && steps.every((step) => step.action === 'noop') ? 'noop' : 'protect';
  return { kind, from, target, steps };
}
