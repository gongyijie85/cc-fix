import { describe, expect, it } from 'vitest';
import { planTransition } from './planner.js';

describe('differential transition planner', () => {
  it('keeps locale/language/culture out of standard plans', () => {
    const plan = planTransition({ committedTarget: null, requestedTarget: { mode: 'standard', region: 'us' }, observed: {} });
    expect(plan.steps.map((s) => s.id)).toEqual(['environment', 'system_timezone', 'browser_policies']);
  });
  it('adds deep authorities and restores them on deep to standard', () => {
    const deep = planTransition({ committedTarget: null, requestedTarget: { mode: 'deep', region: 'jp' }, observed: {} });
    expect(deep.steps.map((s) => s.id)).toEqual(['environment', 'system_timezone', 'browser_policies', 'locale_name', 'user_languages', 'user_culture']);
    const down = planTransition({ committedTarget: { mode: 'deep', region: 'jp' }, requestedTarget: { mode: 'standard', region: 'jp' }, observed: { environment: true, system_timezone: true, browser_policies: true } });
    expect(down.steps.filter((s) => s.action === 'restore').map((s) => s.id)).toEqual(['locale_name', 'user_languages', 'user_culture']);
  });
  it('models repeat alignment, region switches, restore and daily off as stable plans', () => {
    const stable = planTransition({ committedTarget: { mode: 'standard', region: 'us' }, requestedTarget: { mode: 'standard', region: 'us' }, observed: { environment: true, system_timezone: true, browser_policies: true } });
    expect(stable.kind).toBe('noop');
    const switched = planTransition({ committedTarget: { mode: 'standard', region: 'us' }, requestedTarget: { mode: 'standard', region: 'eu' }, observed: {} });
    expect(switched.kind).toBe('protect');
    expect(planTransition({ committedTarget: switched.target, requestedTarget: null, observed: {} }).kind).toBe('restore');
    expect(planTransition({ committedTarget: null, requestedTarget: null, observed: {} })).toMatchObject({ kind: 'noop', steps: [] });
  });
  it('has no external network setting in any plan vocabulary', () => {
    const plan = planTransition({ committedTarget: null, requestedTarget: { mode: 'deep', region: 'sg' }, observed: {} });
    expect(plan.steps.map((s) => s.id).join(' ')).not.toMatch(/vpn|route|adapter|host|doh|dns/i);
  });
});
