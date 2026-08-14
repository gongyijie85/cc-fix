// 检测侧的权威系统状态读取（issue #45）：常驻进程不能依赖启动时 env 快照。

import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function regQueryString(keyPath: string, valueName: string): string | null {
  try {
    const result = execSync(`reg query "${keyPath}" /v ${valueName}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const match = result.match(/REG_SZ\s+(.+)/);
    return match ? match[1].trim() : null;
  } catch { return null; }
}

/** HKCU\\Environment 用户环境变量（persist 的权威存储）。 */
export function readUserEnvVar(name: string): string | null {
  if (process.platform === 'win32') return regQueryString('HKCU\\Environment', name);
  return process.env[name] ?? null;
}

/** 用户 Locale 名称（Windows 区域格式的权威存储）。 */
export function readUserLocale(): string | null {
  if (process.platform === 'win32') return regQueryString('HKCU\\Control Panel\\International', 'LocaleName');
  return null;
}

/**
 * 真实系统时区（IANA）：子进程剥离 TZ 环境变量后由 ICU 解析操作系统时区，
 * 避免常驻进程内 Intl 被 launch-time TZ 快照支配。
 */
export async function readSystemTimezoneIana(): Promise<string> {
  if (process.platform === 'win32') {
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.TZ;
    try {
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', 'console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)'], { env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      const zone = stdout.trim();
      if (zone.length > 0) return zone;
    } catch { /* 回落 */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
