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

  it('reads non-REG_SZ policy values as their string data without crashing (real-machine REG_DWORD case)', async () => {
    const runner: WindowsCommandRunner = async (_executable, args) => {
      if (args[0] === 'query') {
        const valueName = args[3];
        return {
          stdout: valueName === 'DefaultWebRtcIPHandlingPolicy'
            ? '    DefaultWebRtcIPHandlingPolicy    REG_DWORD    0x4\r\n'
            : '    AcceptLanguage    REG_SZ    en-US,en;q=0.9\r\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    const registry = createNativeBrowserPolicyRegistry(runner);
    await expect(registry.read('edge.webrtc')).resolves.toBe('0x4');
    await expect(registry.read('edge.accept_language')).resolves.toBe('en-US,en;q=0.9');
  });

  it('reads REG_EXPAND_SZ and empty-named values as strings; missing key returns null', async () => {
    const expand: WindowsCommandRunner = async () => ({ stdout: '    AcceptLanguage    REG_EXPAND_SZ    %LANG%\r\n', stderr: '' });
    await expect(createNativeBrowserPolicyRegistry(expand).read('chrome.accept_language')).resolves.toBe('%LANG%');
    const none: WindowsCommandRunner = async () => ({ stdout: '    AcceptLanguage    REG_NONE\r\n', stderr: '' });
    await expect(createNativeBrowserPolicyRegistry(none).read('chrome.accept_language')).resolves.toBe('');
    const missing: WindowsCommandRunner = async () => { throw new Error('Unable to find the specified registry key or value.'); };
    await expect(createNativeBrowserPolicyRegistry(missing).read('chrome.accept_language')).resolves.toBeNull();
  });

  it('treats GBK-mojibake / exit-code-1 reg errors as missing (encoding-independent)', async () => {
    // 中文系统 reg.exe 以 GBK 输出「系统找不到指定的注册表项或值」，UTF-8 解码后为乱码，文本匹配失效。
    const gbkMissing: WindowsCommandRunner = async () => {
      throw Object.assign(new Error('Command failed: reg.exe query HKCU\\Environment /v LANG'), { code: 1, stderr: 'ϵͳ�Ҳ���ָ����ע������ֵ��' });
    };
    await expect(createNativeEnvironmentRegistry(gbkMissing).read('LANG')).resolves.toBeNull();
  });

  it('treats exit-code-5 reg errors as access denied (encoding-independent)', async () => {
    const denied: WindowsCommandRunner = async () => {
      throw Object.assign(new Error('Command failed: reg.exe add ...'), { code: 5, stderr: 'Ȩ���ܾ�' });
    };
    await expect(createNativeBrowserPolicyRegistry(denied).write('chrome.accept_language', 'en-US')).resolves.toBe('access_denied');
  });

  it('contains no VPN, route, adapter, DNS, hosts or DoH write surface', () => {
    expect(Object.keys(createNativeEnvironmentRegistry(async () => ({ stdout: '', stderr: '' })))).toEqual(['read', 'write', 'remove']);
    expect(JSON.stringify([storedMissing(), storedValue('x')])).not.toMatch(/vpn|route|adapter|dns|hosts|doh/iu);
  });
});
