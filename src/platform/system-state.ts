// 检测侧的权威系统状态读取（issue #45）：常驻进程不能依赖启动时 env 快照。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function regQueryString(keyPath: string, valueName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', keyPath, '/v', valueName], { encoding: 'utf8', windowsHide: true });
    const match = stdout.match(/REG_SZ\s+(.+)/);
    return match ? match[1].trim() : null;
  } catch { return null; }
}

/** HKCU\\Environment 用户环境变量（persist 的权威存储）。异步（issue #61）：不在事件循环同步阻塞。 */
export async function readUserEnvVar(name: string): Promise<string | null> {
  if (process.platform === 'win32') return regQueryString('HKCU\\Environment', name);
  return process.env[name] ?? null;
}

/** 用户 Locale 名称（Windows 区域格式的权威存储）。异步（issue #61）。 */
export async function readUserLocale(): Promise<string | null> {
  if (process.platform === 'win32') return regQueryString('HKCU\\Control Panel\\International', 'LocaleName');
  return null;
}

/**
 * 真实系统状态（缓存单飞）：子进程剥离 TZ 环境变量后由 ICU 解析操作系统时区与 UTC 偏移，
 * 避免常驻进程内 Intl / Date 被 launch-time TZ 快照支配（issue #45）。
 */
export type SystemStateSnapshot = Readonly<{ timezone: string; offsetMinutes: number }>;

let systemStatePromise: Promise<SystemStateSnapshot> | undefined;

export function systemState(): Promise<SystemStateSnapshot> {
  systemStatePromise ??= computeSystemState();
  return systemStatePromise;
}

/** 每次检测运行开始时重置（issue #45 后续）：缓存仅在单次检测内共享，跨次检测必须重读系统状态。 */
export function resetSystemState(): void {
  systemStatePromise = undefined;
}

async function computeSystemState(): Promise<SystemStateSnapshot> {
  if (process.platform === 'win32') {
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.TZ;
    try {
      const script = 'console.log(JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, offsetMinutes: -new Date().getTimezoneOffset() }))';
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      const parsed = JSON.parse(stdout.trim()) as SystemStateSnapshot;
      if (typeof parsed.timezone === 'string' && parsed.timezone.length > 0 && Number.isFinite(parsed.offsetMinutes)) return Object.freeze(parsed);
    } catch (error) {
      // issue #61：子进程探测失败时回落进程内 Intl 是可观测的降级——常驻进程会继续用
      // launch-time TZ 快照打分（issue #45 的根因场景），必须告警而非静默吞掉。
      console.warn('[system-state] 子进程时区探测失败，回落到进程内 Intl：', error instanceof Error ? error.message : String(error));
    }
  }
  return Object.freeze({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, offsetMinutes: -new Date().getTimezoneOffset() });
}

/** 真实系统时区（IANA）；兼容旧导出。 */
export async function readSystemTimezoneIana(): Promise<string> {
  return (await systemState()).timezone;
}