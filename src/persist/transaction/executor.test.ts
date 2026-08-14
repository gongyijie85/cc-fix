import { describe, expect, it } from 'vitest';
import { storedValue } from '../../state/schema.js';
import { captureJournalPlan, executePlan } from './internal/executor.js';
import type { PersistStepId } from '../steps.js';

function fixture(fail = new Set<PersistStepId>()) {
  const values: Record<PersistStepId, string> = { environment: 'old-env', system_timezone: 'old-tz', browser_policies: 'old-policy', locale_name: 'old-locale', user_languages: 'old-languages', user_culture: 'old-culture' };
  const events: string[] = [];
  const authorities = Object.fromEntries(Object.keys(values).map((id) => [id, { read: async () => storedValue(values[id as PersistStepId]), write: async (value: ReturnType<typeof storedValue<string>>) => { events.push(`write:${id}:${value.value}`); if (fail.has(id as PersistStepId) && value.value.startsWith('new-')) throw new Error('fatal'); values[id as PersistStepId] = value.value; } }])) as never;
  const desired = Object.fromEntries(Object.keys(values).map((id) => [id, storedValue(`new-${id}`)])) as never;
  return { values, events, authorities, desired, journal: { transition: async (id: string, phase: string) => events.push(`${phase}:${id}`) } as never };
}
describe('transition executor', () => {
  it('captures every original and desired value before writes begin', async () => {
    const f = fixture();
    const captured = await captureJournalPlan({ ...f, steps: [{ id: 'environment', disposition: 'required', action: 'apply' }] });
    expect(captured).toEqual([{ id: 'environment', original: storedValue('old-env'), desired: storedValue('new-environment') }]);
    expect(f.events).toEqual([]);
  });
  it('journals before write, verifies, and reverses all modified steps after failure', async () => {
    const f = fixture(new Set(['system_timezone']));
    const result = await executePlan({ ...f, steps: [{ id: 'environment', disposition: 'required', action: 'apply' }, { id: 'system_timezone', disposition: 'required', action: 'apply' }] });
    expect(result.kind).toBe('compensated');
    expect(f.values.environment).toBe('old-env');
    expect(f.values.system_timezone).toBe('old-tz');
    expect(f.events).toContain('applying:environment');
    expect(f.events).toContain('compensated:environment');
  });
  it('fails closed: a rejected policy write compensates like any required step (ADR-0011 T1)', async () => {
    const f = fixture();
    f.authorities.browser_policies.write = async (value: ReturnType<typeof storedValue<string>>) => {
      if (value.value.startsWith('new-')) throw new Error('Access is denied.');
      f.values.browser_policies = value.value;
    };
    const result = await executePlan({ ...f, steps: [{ id: 'browser_policies', disposition: 'required', action: 'apply' }] });
    expect(result.kind).toBe('compensated');
    expect(f.values.browser_policies).toBe('old-policy');
    expect(f.events).toContain('compensated:browser_policies');
  });
  it('commits degraded per slot: written subset stays, unaligned slots recorded (ADR-0011 T2)', async () => {
    const f = fixture();
    f.authorities.browser_policies.write = async () => ({ unaligned: [{ kind: 'browser_policy_unaligned', slot: 'chrome.webrtc', cause: 'access_denied' }] });
    const result = await executePlan({ ...f, steps: [{ id: 'browser_policies', disposition: 'degradable', action: 'apply' }] });
    expect(result).toMatchObject({ kind: 'degraded', degraded: [{ kind: 'browser_policy_unaligned', slot: 'chrome.webrtc', cause: 'access_denied' }] });
    expect(f.events).toContain('verified:browser_policies');
    expect(f.events).not.toContain('compensating:browser_policies');
  });
  it('rejects per-slot denials on a required (non-degradable) step', async () => {
    const f = fixture();
    f.authorities.environment.write = async () => ({ unaligned: [{ kind: 'browser_policy_unaligned', slot: 'chrome.webrtc', cause: 'access_denied' }] });
    const result = await executePlan({ ...f, steps: [{ id: 'environment', disposition: 'required', action: 'apply' }] });
    expect(result.kind).toBe('compensated');
  });
  it('compensates when the post-write readback does not match the desired value', async () => {
    const f = fixture();
    f.authorities.environment.write = async () => { f.values.environment = 'written'; };
    f.authorities.environment.read = async () => storedValue('something-else');
    const result = await executePlan({ ...f, steps: [{ id: 'environment', disposition: 'required', action: 'apply' }] });
    expect(result.kind).toBe('compensated');
  });
  it('survives a failed recovery_required journal transition during compensation', async () => {
    const f = fixture(new Set(['system_timezone']));
    const originalTransition = f.journal.transition;
    f.journal.transition = async (id: string, phase: string) => {
      if (phase === 'recovery_required') throw new Error('journal unavailable');
      await originalTransition(id, phase);
    };
    f.authorities.environment.write = async (value: ReturnType<typeof storedValue<string>>) => {
      if (value.value === 'old-env') throw new Error('compensation blocked');
      f.values.environment = value.value;
    };
    const result = await executePlan({ ...f, steps: [{ id: 'environment', disposition: 'required', action: 'apply' }, { id: 'system_timezone', disposition: 'required', action: 'apply' }] });
    expect(result.kind).toBe('recovery_required');
  });
  it('marks recovery required when compensation itself cannot be verified', async () => {
    const f = fixture(new Set(['system_timezone']));
    const originalWrite = f.authorities.environment.write;
    f.authorities.environment.write = async (value: ReturnType<typeof storedValue<string>>) => {
      if (value.value === 'old-env') throw new Error('compensation blocked');
      await originalWrite(value);
    };
    const result = await executePlan({ ...f, steps: [{ id: 'environment', disposition: 'required', action: 'apply' }, { id: 'system_timezone', disposition: 'required', action: 'apply' }] });
    expect(result.kind).toBe('recovery_required');
  });
});