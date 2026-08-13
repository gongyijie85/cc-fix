/** Identity of a lock holder.  A PID alone is never sufficient because PIDs can be reused. */
export type ProcessOwner = Readonly<{
  pid: number;
  startedAtMs: number;
  heartbeatAtMs: number;
}>;

export interface ProcessInspector {
  current(): Promise<Pick<ProcessOwner, 'pid' | 'startedAtMs'>>;
  /** Returns false for a missing PID or a process whose creation time differs. */
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
