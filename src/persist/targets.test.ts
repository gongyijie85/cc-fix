import { describe, expect, it } from 'vitest';
import { desiredValues } from './targets.js';
describe('target values', () => {
  it('derives only catalogued authority values without network settings', () => {
    const values = desiredValues({ mode: 'deep', region: 'jp' });
    expect(values.system_timezone).toMatchObject({ value: 'Tokyo Standard Time' });
    expect(values.user_languages).toMatchObject({ value: ['ja-JP'] });
    expect(JSON.stringify(values)).not.toMatch(/vpn|route|adapter|host|doh|dns/i);
  });
});
