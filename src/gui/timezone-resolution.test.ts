import { afterEach, describe, expect, it, vi } from 'vitest';

const probes = vi.hoisted(() => ({ timezone: 'America/New_York' }));
const runtime = vi.hoisted(() => ({
  status: vi.fn(async () => ({
    mode: 'standard', target: { mode: 'standard', region: 'us' }, preferredRegion: 'us',
    health: 'healthy', transaction: { kind: 'none' }, revision: 1, updatedAt: '2026-01-01T00:00:00.000Z',
  })),
  protect: vi.fn(async () => ({ kind: 'committable' })),
  detect: vi.fn(async () => undefined),
}));

vi.mock('./index.html', () => ({ default: '<!doctype html>' }));
vi.mock('../fix/history.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../fix/history.js')>(),
  recordFixSummary: vi.fn(async () => true),
}));
vi.mock('../detection/runner.js', () => ({ runDetection: runtime.detect }));
vi.mock('../platform/browser.js', () => ({ detectRunningBrowsers: async () => [] }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  // 使用真实 system-state 缓存，只替换系统探测边界；不修改本机时区。
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (error: null, output: { stdout: string }) => void;
    callback(null, { stdout: JSON.stringify({ timezone: probes.timezone, offsetMinutes: -420 }) });
  }),
}));

import { startGuiServer, type GuiHttpServer } from './server.js';
import { resetSystemState, systemState } from '../platform/system-state.js';

let server: GuiHttpServer | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  resetSystemState();
  vi.restoreAllMocks();
  runtime.protect.mockClear();
  runtime.detect.mockClear();
});

describe('legacy city selection after the OS timezone changes', () => {
  it.each(['status', 'protect', 'check'])('%s uses the new OS city on its first request', async (operation) => {
    const localOptions = Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => ({
      ...localOptions, timeZone: probes.timezone,
    }));
    probes.timezone = 'America/New_York';
    resetSystemState();
    expect((await systemState()).timezone).toBe('America/New_York');

    server = await startGuiServer(0, { createRuntime: async () => runtime as never, ipIntelFetcher: async () => null });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No server address');
    const origin = `http://127.0.0.1:${address.port}`;
    const bootstrap = await fetch(server.bootstrapUrl(), { redirect: 'manual' });
    const cookie = bootstrap.headers.get('set-cookie')!.split(';', 1)[0]!;

    probes.timezone = 'America/Los_Angeles';
    const path = operation === 'status' ? '/api/status' : operation === 'protect' ? '/api/fix/on' : '/api/check/start';
    const response = await fetch(`${origin}${path}`, {
      method: operation === 'status' ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: origin },
    });
    if (operation === 'status') {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ currentTimezone: 'America/Los_Angeles', resolvedTimezone: 'America/Los_Angeles' });
    } else if (operation === 'protect') {
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(runtime.protect).toHaveBeenCalledWith({ mode: 'standard', region: 'us', timezone: 'America/Los_Angeles' }));
    } else {
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(runtime.detect).toHaveBeenCalledWith('auto', 'America/Los_Angeles', 'en_US.UTF-8', null, expect.any(Function)));
    }
  });
});
