import type { ProtectionTarget } from '../domain/protection.js';

export const STANDARD_STEP_IDS = ['environment', 'system_timezone', 'browser_policies'] as const;
export const DEEP_ONLY_STEP_IDS = ['locale_name', 'user_languages', 'user_culture'] as const;
export const ALL_STEP_IDS = [...STANDARD_STEP_IDS, ...DEEP_ONLY_STEP_IDS] as const;
export type PersistStepId = (typeof ALL_STEP_IDS)[number];
export type PlanDisposition = 'required' | 'skipped' | 'degradable';
export type PlannedStep = Readonly<{ id: PersistStepId; disposition: PlanDisposition; action: 'apply' | 'restore' | 'noop' }>;

export function managedStepIds(target: ProtectionTarget): readonly PersistStepId[] {
  return target.mode === 'deep' ? ALL_STEP_IDS : STANDARD_STEP_IDS;
}
