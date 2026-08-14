import { describe, expect, it } from 'vitest';
import { resetSystemState, systemState } from './system-state.js';

describe('system state snapshot cache (issue #45)', () => {
  it('shares one snapshot within a detection run and refreshes after a reset', async () => {
    const first = systemState();
    const second = systemState();
    expect(second).toBe(first);
    const snapshot = await first;
    expect(typeof snapshot.timezone).toBe('string');
    expect(snapshot.timezone.length).toBeGreaterThan(0);
    expect(Number.isFinite(snapshot.offsetMinutes)).toBe(true);
    resetSystemState();
    const third = systemState();
    expect(third).not.toBe(first);
    expect(await third).toMatchObject({ timezone: snapshot.timezone });
  });
});