import { describe, expect, it } from 'vitest';
import { storedValue } from '../state/schema.js';
import { restoreAll } from './restore.js';
import type { PersistStepId } from './steps.js';

describe('convergent restore', () => {
  it('continues after simultaneous failures and remains idempotent on retry', async () => {
    const values = { environment: 'protected', system_timezone: 'protected' };
    let failEnv = true;
    const authorities = {
      environment: { read: async () => storedValue(values.environment), write: async (value: ReturnType<typeof storedValue<string>>) => { if (failEnv) throw new Error('blocked'); values.environment = value.value; } },
      system_timezone: { read: async () => storedValue(values.system_timezone), write: async (value: ReturnType<typeof storedValue<string>>) => { values.system_timezone = value.value; } },
    } as never;
    const input = { order: ['environment', 'system_timezone'] as PersistStepId[], daily: { environment: storedValue('daily-env'), system_timezone: storedValue('daily-tz') } as never, authorities, journal: { transition: async () => undefined } as never };
    expect(await restoreAll(input)).toEqual({ verified: ['system_timezone'], failed: ['environment'] });
    expect(values.system_timezone).toBe('daily-tz');
    failEnv = false;
    expect((await restoreAll(input)).failed).toEqual([]);
    expect(values.environment).toBe('daily-env');
  });
});
