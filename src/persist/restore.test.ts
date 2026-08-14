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
  it('treats per-slot write denials as a failed step and keeps converging', async () => {
    const values = { environment: 'protected', system_timezone: 'protected' };
    const authorities = {
      environment: { read: async () => storedValue(values.environment), write: async () => ({ unaligned: [{ kind: 'browser_policy_unaligned', slot: 'chrome.webrtc', cause: 'access_denied' }] }) },
      system_timezone: { read: async () => storedValue(values.system_timezone), write: async (value: ReturnType<typeof storedValue<string>>) => { values.system_timezone = value.value; } },
    } as never;
    const input = { order: ['environment', 'system_timezone'] as PersistStepId[], daily: { environment: storedValue('daily-env'), system_timezone: storedValue('daily-tz') } as never, authorities, journal: { transition: async () => undefined } as never };
    expect(await restoreAll(input)).toEqual({ verified: ['system_timezone'], failed: ['environment'] });
  });
  it('continues even when journal reporting also fails', async () => {
    const authority = { read: async () => storedValue('protected'), write: async () => { throw new Error('blocked'); } };
    const result = await restoreAll({ order: ['environment'], daily: { environment: storedValue('daily') } as never, authorities: { environment: authority } as never, journal: { transition: async () => { throw new Error('journal unavailable'); } } as never });
    expect(result).toEqual({ verified: [], failed: ['environment'] });
  });
});
