import { describe, expect, it } from 'vitest';
import { storedValue } from '../state/schema.js';
import { executePlan, PolicyManagedOrDeniedError } from './executor.js';
import type { PersistStepId } from './steps.js';

function fixture(fail = new Set<PersistStepId>()) {
  const values: Record<PersistStepId, string> = { environment: 'old-env', system_timezone: 'old-tz', browser_policies: 'old-policy', locale_name: 'old-locale', user_languages: 'old-languages', user_culture: 'old-culture' };
  const events: string[] = [];
  const authorities = Object.fromEntries(Object.keys(values).map((id) => [id, { read: async () => storedValue(values[id as PersistStepId]), write: async (value: ReturnType<typeof storedValue<string>>) => { events.push(`write:${id}:${value.value}`); if (fail.has(id as PersistStepId) && value.value.startsWith('new-')) throw new Error('fatal'); values[id as PersistStepId] = value.value; } }])) as never;
  const desired = Object.fromEntries(Object.keys(values).map((id) => [id, storedValue(`new-${id}`)])) as never;
  return { values, events, authorities, desired, journal: { transition: async (id: string, phase: string) => events.push(`${phase}:${id}`) } as never };
}
describe('transition executor', () => {
  it('journals before write, verifies, and reverses all modified steps after failure', async () => {
    const f = fixture(new Set(['system_timezone']));
    const result = await executePlan({ ...f, steps: [{ id: 'environment', disposition: 'required', action: 'apply' }, { id: 'system_timezone', disposition: 'required', action: 'apply' }] });
    expect(result.kind).toBe('compensated');
    expect(f.values.environment).toBe('old-env');
    expect(f.values.system_timezone).toBe('old-tz');
    expect(f.events).toContain('applying:environment');
    expect(f.events).toContain('compensated:environment');
  });
  it('only permits policy managed/denied to degrade a committed target', async () => {
    const f = fixture();
    f.authorities.browser_policies.write = async () => { throw new PolicyManagedOrDeniedError(); };
    const result = await executePlan({ ...f, steps: [{ id: 'browser_policies', disposition: 'degradable', action: 'apply' }] });
    expect(result).toMatchObject({ kind: 'degraded', degraded: ['browser_policies'] });
  });
});
