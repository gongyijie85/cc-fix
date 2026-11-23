import { describe, expect, it } from 'vitest';
import { getTargetRegion, resolveTargetTimezone, TimezoneResolutionError } from './region-catalog.js';

describe('specific target timezones', () => {
  it('maps Los Angeles to matching IANA and Windows values without changing the US default', () => {
    expect(getTargetRegion('us', 'America/Los_Angeles')).toMatchObject({
      timezone: 'America/Los_Angeles', winTimezone: 'Pacific Standard Time', lang: 'en_US.UTF-8',
    });
    expect(getTargetRegion('us').timezone).toBe('America/New_York');
  });

  it.each(['', 'US/Pacific', 'Asia/Tokyo', null, 123])('rejects unsupported US timezone %j', (explicit) => {
    expect(() => resolveTargetTimezone({ region: 'us', explicit })).toThrow(TimezoneResolutionError);
  });

  it('preserves the manually aligned local timezone for legacy country-only state', () => {
    expect(resolveTargetTimezone({ region: 'us', active: { region: 'us' }, current: 'America/Los_Angeles' }))
      .toBe('America/Los_Angeles');
  });

  it('keeps the committed timezone ahead of later local drift, even with an explicit matching region', () => {
    expect(resolveTargetTimezone({
      region: 'us', active: { region: 'us', timezone: 'America/Los_Angeles' }, current: 'America/New_York',
    })).toBe('America/Los_Angeles');
  });

  it('lets an explicit timezone switch the active US city', () => {
    expect(resolveTargetTimezone({
      region: 'us', explicit: 'America/Chicago', active: { region: 'us', timezone: 'America/Los_Angeles' },
    })).toBe('America/Chicago');
  });

  it('does not carry an American timezone into a Japan switch', () => {
    expect(resolveTargetTimezone({
      region: 'jp', active: { region: 'us', timezone: 'America/Los_Angeles' }, current: 'America/Los_Angeles',
    })).toBe('Asia/Tokyo');
  });
});
