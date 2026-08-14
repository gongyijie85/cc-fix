import { describe, expect, it } from 'vitest';
import { storedMissing, storedValue } from '../../state/schema.js';
import { createNativeBrowserPolicyRegistry, createNativeEnvironmentRegistry, createNativeLocaleRegistry, createNativeTimezoneSystem, type WindowsCommandRunner } from './native-backend.js';

describe('native Windows persist backend', () => {
  it('passes registry values and timezone ids as literal argv without shell interpolation', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const runner: WindowsCommandRunner = async (executable, args) => { calls.push({ executable, args }); return { stdout: '', stderr: '' }; };
    await createNativeEnvironmentRegistry(runner).write('LANG', 'value & whoami " literal');
    await createNativeTimezoneSystem(runner).write('Tokyo Standard Time');
    expect(calls[0]).toEqual({ executable: 'reg.exe', args: ['add', 'HKCU\\Environment', '/v', 'LANG', '/t', 'REG_SZ', '/d', 'value & whoami " literal', '/f'] });
    expect(calls[1]).toEqual({ executable: 'tzutil.exe', args: ['/s', 'Tokyo Standard Time'] });
  });

  it('round-trips missing, empty and multi-language values without collapsing them', async () => {
    const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: WindowsCommandRunner = async (_executable, args, options) => {
      calls.push({ args, env: options?.env });
      if (args[0] === 'query') return { stdout: '    LocaleName    REG_SZ    \r\n', stderr: '' };
      if (args.at(-1)?.includes('ConvertTo-Json -InputObject $tags')) return { stdout: '["zh-CN","en-US"]', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const environment = createNativeEnvironmentRegistry(runner);
    await expect(environment.read('LANG')).resolves.toBe('');
    const locale = createNativeLocaleRegistry(runner);
    await expect(locale.readLanguages()).resolves.toEqual(['zh-CN', 'en-US']);
    await locale.writeLanguages(['zh-CN', 'en-US']);
    const encoded = calls.at(-1)?.env?.CC_FIX_INPUT_B64;
    expect(JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8'))).toEqual(['zh-CN', 'en-US']);
  });

  it('reports per-slot access denial while unknown failures propagate raw (ADR-0011 T2)', async () => {
    const denied: WindowsCommandRunner = async () => { throw Object.assign(new Error('Access is denied.'), { stderr: 'Access is denied.' }); };
    await expect(createNativeBrowserPolicyRegistry(denied).write('chrome.accept_language', 'en-US')).resolves.toBe('access_denied');
    const unknown: WindowsCommandRunner = async () => { throw new Error('device failure'); };
    await expect(createNativeBrowserPolicyRegistry(unknown).write('chrome.accept_language', 'en-US')).rejects.toThrow('device failure');
  });

  it('contains no VPN, route, adapter, DNS, hosts or DoH write surface', () => {
    expect(Object.keys(createNativeEnvironmentRegistry(async () => ({ stdout: '', stderr: '' })))).toEqual(['read', 'write', 'remove']);
    expect(JSON.stringify([storedMissing(), storedValue('x')])).not.toMatch(/vpn|route|adapter|dns|hosts|doh/iu);
  });
});
