import { describe, expect, it, afterEach } from 'vitest';
import { resetSystemState, systemState } from './system-state.js';

const originalTz = process.env.TZ;

afterEach(() => {
  resetSystemState();
  if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
});

describe('system state snapshot (issue #45 回归)', () => {
  it('ignores a forced TZ env var and reports the real OS timezone', async () => {
    process.env.TZ = 'America/New_York';
    const snapshot = await systemState();
    // 子进程剥离 TZ 后读取操作系统时区；本机/CI 的 OS 时区不是 America/New_York
    expect(snapshot.timezone).not.toBe('America/New_York');
    expect(snapshot.offsetMinutes).not.toBe(-300);
  });

  it('shares one snapshot within a run and refreshes after a reset', async () => {
    const first = systemState();
    const second = systemState();
    expect(second).toBe(first);
    const snapshot = await first;
    expect(typeof snapshot.timezone).toBe('string');
    expect(Number.isFinite(snapshot.offsetMinutes)).toBe(true);
    resetSystemState();
    expect(systemState()).not.toBe(first);
  });
});