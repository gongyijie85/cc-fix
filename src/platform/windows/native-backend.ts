import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BROWSER_POLICY_SLOTS, type BrowserPolicySlotId } from '../../state/schema.js';
import { createBrowserPolicyProfileAuthority, type BrowserPolicyRegistry, type BrowserPolicyWriteResult } from './browser-policy.js';
import type { ExecutableAuthority } from '../../persist/authority.js';
import type { PersistStepId } from '../../persist/steps.js';
import { createEnvironmentProfileAuthority, type EnvironmentRegistry } from './environment.js';
import { createLocaleAuthorities, type LocaleRegistry } from './locale.js';
import { createTimezoneAuthority, type TimezoneSystem } from './timezone.js';

const execFileAsync = promisify(execFile);

export type WindowsCommandResult = Readonly<{ stdout: string; stderr: string }>;
export type WindowsCommandRunner = (
  executable: string,
  args: readonly string[],
  options?: Readonly<{ env?: NodeJS.ProcessEnv }>,
) => Promise<WindowsCommandResult>;

export const runWindowsCommand: WindowsCommandRunner = async (executable, args, options) => {
  const result = await execFileAsync(executable, [...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    env: options?.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function commandErrorText(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const candidate = error as { message?: unknown; stderr?: unknown };
  return `${String(candidate.message ?? '')}\n${String(candidate.stderr ?? '')}`;
}

function isAccessDeniedError(error: unknown): boolean {
  const text = commandErrorText(error);
  return /access is denied|access denied|拒绝访问|权限/iu.test(text);
}

function isMissingRegistryError(error: unknown): boolean {
  const text = commandErrorText(error);
  return /unable to find|cannot find|not found|找不到|不存在/iu.test(text);
}

// 兼容任意注册表值类型：浏览器策略槽在真实机可能被以 REG_DWORD 等非 REG_SZ 存储
// （验收发现 DefaultWebRtcIPHandlingPolicy=REG_DWORD 0x4），不能因类型不符而硬抛导致整个 persist 事务失败。
// 读取以字符串形式 best-effort 返回（类型无关，取数据段），写入时归一为期望的 REG_SZ。
const registryTypeLine = /^[ \t]*\S+[ \t]+(REG_[A-Z_]+)(?:[ \t]+(.*))?[ \t]*$/iu;

async function readRegistryString(
  runner: WindowsCommandRunner,
  keyPath: string,
  valueName: string,
): Promise<string | null> {
  try {
    const result = await runner('reg.exe', ['query', keyPath, '/v', valueName]);
    const match = result.stdout.split(/\r?\n/u).map((line) => registryTypeLine.exec(line)).find((candidate) => candidate !== null);
    if (match == null) return null; // 无己知类型行（如 REG_FULL_RESOURCE 等未知形态）——视同缺失
    return match[2] ?? '';
  } catch (error) {
    if (isMissingRegistryError(error)) return null;
    if (isAccessDeniedError(error)) return null; // 读被拒视同缺失，写路径按槽汇报退化
    throw error;
  }
}

async function writeRegistryString(
  runner: WindowsCommandRunner,
  keyPath: string,
  valueName: string,
  value: string,
): Promise<void> {
  await runner('reg.exe', ['add', keyPath, '/v', valueName, '/t', 'REG_SZ', '/d', value, '/f']);
}

async function removeRegistryValue(
  runner: WindowsCommandRunner,
  keyPath: string,
  valueName: string,
): Promise<void> {
  try { await runner('reg.exe', ['delete', keyPath, '/v', valueName, '/f']); }
  catch (error) { if (!isMissingRegistryError(error)) throw error; }
}

const POWERSHELL_JSON_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CC_FIX_INPUT_B64))",
  '$value=ConvertFrom-Json -InputObject $json',
].join(';');

function encodedInput(value: unknown): NodeJS.ProcessEnv {
  return { ...process.env, CC_FIX_INPUT_B64: Buffer.from(JSON.stringify(value), 'utf8').toString('base64') };
}

async function runPowerShellJson<T>(runner: WindowsCommandRunner, script: string): Promise<T> {
  const result = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return JSON.parse(result.stdout.trim()) as T;
}

async function writePowerShellJson(
  runner: WindowsCommandRunner,
  script: string,
  value: unknown,
): Promise<void> {
  await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${POWERSHELL_JSON_SCRIPT};${script}`], {
    env: encodedInput(value),
  });
}

export function createNativeEnvironmentRegistry(runner: WindowsCommandRunner): EnvironmentRegistry {
  const path = 'HKCU\\Environment';
  return {
    read: (key) => readRegistryString(runner, path, key),
    write: (key, value) => writeRegistryString(runner, path, key, value),
    remove: (key) => removeRegistryValue(runner, path, key),
  };
}

export function createNativeTimezoneSystem(runner: WindowsCommandRunner): TimezoneSystem {
  return {
    read: async () => (await runner('tzutil.exe', ['/g'])).stdout.trim(),
    write: async (id: string) => { await runner('tzutil.exe', ['/s', id]); },
  };
}

export function createNativeBrowserPolicyRegistry(runner: WindowsCommandRunner): BrowserPolicyRegistry {
  const slot = (id: BrowserPolicySlotId) => BROWSER_POLICY_SLOTS.find((candidate) => candidate.id === id)!;
  return {
    read: async (id) => { const value = slot(id); return readRegistryString(runner, value.keyPath, value.valueName); },
    write: async (id, content): Promise<BrowserPolicyWriteResult> => {
      const value = slot(id);
      try { await writeRegistryString(runner, value.keyPath, value.valueName, content); }
      catch (error) {
        if (isAccessDeniedError(error)) return 'access_denied';
        throw error;
      }
      return 'written';
    },
    remove: async (id) => { const value = slot(id); await removeRegistryValue(runner, value.keyPath, value.valueName); },
  };
}

export function createNativeLocaleRegistry(runner: WindowsCommandRunner): LocaleRegistry {
  const localePath = 'HKCU\\Control Panel\\International';
  return {
    readLocale: () => readRegistryString(runner, localePath, 'LocaleName'),
    writeLocale: (value) => writeRegistryString(runner, localePath, 'LocaleName', value),
    removeLocale: () => removeRegistryValue(runner, localePath, 'LocaleName'),
    readLanguages: () => runPowerShellJson<string[]>(
      runner,
      '$tags=@(Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag });ConvertTo-Json -InputObject $tags -Compress',
    ),
    writeLanguages: (value) => writePowerShellJson(
      runner,
      "$tags=@($value);if($tags.Count -eq 0){Set-WinUserLanguageList -LanguageList @() -Force}else{$list=New-WinUserLanguageList -Language $tags[0];foreach($tag in $tags|Select-Object -Skip 1){$list.Add([string]$tag)|Out-Null};Set-WinUserLanguageList -LanguageList $list -Force}",
      value,
    ),
    removeLanguages: () => writePowerShellJson(
      runner,
      'Set-WinUserLanguageList -LanguageList @() -Force',
      [],
    ),
    readCulture: () => runPowerShellJson<string>(runner, 'ConvertTo-Json -InputObject (Get-Culture).Name -Compress'),
    writeCulture: (value) => writePowerShellJson(runner, 'Set-Culture -CultureInfo ([string]$value)', value),
    removeCulture: async () => { throw new Error('Windows Culture has no safe missing-value representation'); },
  };
}

/** Production authority composition. No network setting is present. */
export function createNativePersistAuthoritySet(runner: WindowsCommandRunner = runWindowsCommand): Readonly<Record<PersistStepId, ExecutableAuthority>> {
  const locale = createLocaleAuthorities(createNativeLocaleRegistry(runner));
  return Object.freeze({
    environment: createEnvironmentProfileAuthority(createNativeEnvironmentRegistry(runner)),
    system_timezone: createTimezoneAuthority(createNativeTimezoneSystem(runner)),
    browser_policies: createBrowserPolicyProfileAuthority(createNativeBrowserPolicyRegistry(runner)),
    locale_name: locale.localeName,
    user_languages: locale.userLanguages,
    user_culture: locale.userCulture,
  });
}

