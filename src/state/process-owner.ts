/** Identity of a lock holder.  A PID alone is never sufficient because PIDs can be reused. */
export type ProcessOwner = Readonly<{
  pid: number;
  startedAtMs: number;
  heartbeatAtMs: number;
}>;

export interface ProcessInspector {
  current(): Promise<Pick<ProcessOwner, 'pid' | 'startedAtMs'>>;
  /**
   * Returns false for a missing PID or a process whose creation time differs.
   * Throws when liveness cannot be determined (issue #51 M1) — an unknown
   * state must never be reported as "dead", or the takeover path would
   * displace a live owner.
   */
  isSameProcess(owner: Pick<ProcessOwner, 'pid' | 'startedAtMs'>): Promise<boolean>;
}

/**
 * Node can prove the identity of its own process but cannot portably obtain the
 * start time of arbitrary Windows processes.  Production supplies the native
 * Windows inspector in T22; until then stale take-over fails closed.
 */
const nodeStartedAtMs = Math.floor(Date.now() - process.uptime() * 1_000);

export const nodeProcessInspector: ProcessInspector = {
  current: async () => ({ pid: process.pid, startedAtMs: nodeStartedAtMs }),
  isSameProcess: async (owner) => owner.pid === process.pid && owner.startedAtMs === nodeStartedAtMs,
};

export function createWindowsProcessInspector(
  queryStartedAtMs: (pid: number) => Promise<number | undefined>,
): ProcessInspector {
  let currentIdentity: Promise<Pick<ProcessOwner, 'pid' | 'startedAtMs'>> | undefined;
  // issue #58：同一 pid 的 StartTime 查询短时缓存——PowerShell 冷启动百毫秒级，
  // 锁竞争路径（acquire + isSameProcess 对同一持有者）与 GUI 常驻进程的多次
  // 操作会重复查询同一 pid。缓存 5s 足以覆盖一次事务的生命周期。
  const QUERY_CACHE_TTL_MS = 5_000;
  const queryCache = new Map<number, { at: number; value: number | undefined }>();
  const cachedQuery = async (pid: number): Promise<number | undefined> => {
    const hit = queryCache.get(pid);
    if (hit !== undefined && Date.now() - hit.at < QUERY_CACHE_TTL_MS) return hit.value;
    const value = await queryStartedAtMs(pid);
    queryCache.set(pid, { at: Date.now(), value });
    return value;
  };
  return {
    current: async () => currentIdentity ??= (async () => {
      let startedAtMs: number | undefined;
      try {
        startedAtMs = await cachedQuery(process.pid);
      } catch (error) {
        throw new Error('Cannot establish current process start time', { cause: error });
      }
      if (startedAtMs === undefined) throw new Error('Cannot establish current process start time');
      return { pid: process.pid, startedAtMs };
    })(),
    // 查询失败必须上抛（issue #51 M1）："无法确认存活"绝不等于"进程已死"，
    // 否则接管路径会把活着的持锁进程误判为死亡，造成双持锁并发写。
    isSameProcess: async (owner) => (await cachedQuery(owner.pid)) === owner.startedAtMs,
  };
}
