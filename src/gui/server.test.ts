import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  protect: vi.fn(async (): Promise<{ kind: string; degraded: Array<{ kind: string; slot: string; cause: string }> }> => ({ kind: "committable", degraded: [] })),
  restore: vi.fn(async () => ({ kind: "restored" })),
  recover: vi.fn(async () => ({ kind: "recovered", failed: [] })),
  status: vi.fn(async () => ({ mode: "daily", target: null, preferredRegion: "us", health: "healthy", transaction: { kind: "none" }, revision: 3, updatedAt: "2026-09-04T00:00:00.000Z" })),
}));

vi.mock("./index.html", () => ({ default: "<!doctype html>" }));

const historyMocks = vi.hoisted(() => ({ recordFixSummary: vi.fn(async () => true) }));
vi.mock("../fix/history.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../fix/history.js")>(),
  recordFixSummary: historyMocks.recordFixSummary,
}));

const browserMocks = vi.hoisted(() => ({ detectRunningBrowsers: vi.fn<() => string[]>(() => []) }));

vi.mock("../platform/browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/browser.js")>();
  return { ...actual, detectRunningBrowsers: browserMocks.detectRunningBrowsers };
});

const ipIntelMocks = vi.hoisted(() => ({ fetcher: vi.fn(async () => null) }));
const systemMocks = vi.hoisted(() => ({ read: vi.fn(async () => ({ timezone: 'America/New_York', offsetMinutes: -240 })) }));
vi.mock('../platform/system-state.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../platform/system-state.js')>(),
  systemState: systemMocks.read,
}));

import { startGuiServer, type GuiHttpServer } from "./server.js";

let server: GuiHttpServer | undefined;
let authHeaders: Record<string, string> = {};

async function baseUrl(createRuntime = async () => runtimeMocks as never): Promise<string> {
  server = await startGuiServer(0, {
    createRuntime,
    ipIntelFetcher: ipIntelMocks.fetcher,
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("GUI test server did not bind a TCP port");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const bootstrap = await fetch(server.bootstrapUrl(), { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("GUI bootstrap did not issue a session cookie");
  authHeaders = { Cookie: cookie, Origin: origin };
  return origin;
}

async function closeServer(): Promise<void> {
  if (!server) return;
  const runningServer = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => {
    runningServer.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readStepEvents(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let stream = "";
  while (!stream.includes('"type":"summary"') || !stream.endsWith("\n\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    stream += decoder.decode(value, { stream: true });
  }
  return stream.split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((event) => event.type !== "catalog");
}

beforeEach(() => {
  historyMocks.recordFixSummary.mockClear();
  browserMocks.detectRunningBrowsers.mockClear();
  browserMocks.detectRunningBrowsers.mockReturnValue([]);
  runtimeMocks.protect.mockClear();
  runtimeMocks.restore.mockClear();
  runtimeMocks.recover.mockClear();
  runtimeMocks.status.mockClear();
  ipIntelMocks.fetcher.mockClear();
  ipIntelMocks.fetcher.mockResolvedValue(null);
  systemMocks.read.mockResolvedValue({ timezone: 'America/New_York', offsetMinutes: -240 });
});

describe("POST /api/fix/recover", () => {
  it("routes recovery through the single application service", async () => {
    const origin = await baseUrl();
    const response = await fetch(`${origin}/api/fix/recover`, { method: "POST", headers: authHeaders });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.recover).toHaveBeenCalledTimes(1));
  });
});

describe("SSE attach (#86 IP 情报预取)", () => {
  it("prewarms the IP intelligence fetcher when the browser connects", async () => {
    const origin = await baseUrl();
    const eventsRes = await fetch(`${origin}/api/events`, { headers: authHeaders });
    await vi.waitFor(() => expect(ipIntelMocks.fetcher).toHaveBeenCalledTimes(1));
    await eventsRes.body?.cancel();
  });

  it("fires the prefetch once per SSE connection", async () => {
    const origin = await baseUrl();
    const first = await fetch(`${origin}/api/events`, { headers: authHeaders });
    await vi.waitFor(() => expect(ipIntelMocks.fetcher).toHaveBeenCalledTimes(1));
    await first.body?.cancel();
    const second = await fetch(`${origin}/api/events`, { headers: authHeaders });
    await vi.waitFor(() => expect(ipIntelMocks.fetcher).toHaveBeenCalledTimes(2));
    await second.body?.cancel();
  });

  it("rejects SSE connections beyond the per-session cap with 429 (#62)", async () => {
    const origin = await baseUrl();
    const held: Response[] = [];
    for (let i = 0; i < 16; i++) {
      const res = await fetch(`${origin}/api/events`, { headers: authHeaders });
      expect(res.status).toBe(200);
      held.push(res);
    }
    const rejected = await fetch(`${origin}/api/events`, { headers: authHeaders });
    expect(rejected.status).toBe(429);
    const body = await rejected.json() as { error: string };
    expect(body.error).toBe("too_many_sse_connections");
    for (const res of held) await res.body?.cancel();
  });
});

afterEach(async () => {
  await closeServer();
});

describe("POST /api/fix/on region validation", () => {
  it("retries runtime initialization after a failed warm-up and a failed request", async () => {
    const message = "Persist initialization failed";
    const createRuntime = vi.fn(async () => runtimeMocks as never)
      .mockRejectedValueOnce(new Error(message))
      .mockRejectedValueOnce(new Error(message));
    const origin = await baseUrl(createRuntime);
    const request = () => fetch(`${origin}/api/fix/on`, { method: "POST", headers: authHeaders });

    const failed = await request();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: { id: "PERSIST_PREPARE_FAILED", code: 500, message } });
    expect(historyMocks.recordFixSummary).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.protect).not.toHaveBeenCalled();

    expect((await request()).status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.protect).toHaveBeenCalledTimes(1));
    expect(createRuntime).toHaveBeenCalledTimes(3);
  });

  it("reports a failed status read to the caller, SSE and history, then allows a retry", async () => {
    const origin = await baseUrl();
    const message = "Cannot read persist state";
    const events = await fetch(`${origin}/api/events`, { headers: authHeaders, signal: AbortSignal.timeout(5000) });
    const reader = events.body!.getReader();
    const request = () => fetch(`${origin}/api/fix/on`, { method: "POST", headers: authHeaders });
    try {
      const invalid = await fetch(`${origin}/api/fix/on?level=ultra`, { method: "POST", headers: authHeaders });
      expect(invalid.status).toBe(400);
      expect(historyMocks.recordFixSummary).not.toHaveBeenCalled();
      runtimeMocks.status.mockRejectedValueOnce(new Error(message));
      const response = await request();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { id: "PERSIST_PREPARE_FAILED", code: 500, message } });
      expect(runtimeMocks.protect).not.toHaveBeenCalled();
      const summary = { type: "summary", ok: 0, fail: 1, rolledBack: false, fatal: false, failedDuring: "prepare" };
      expect(await readStepEvents(reader)).toEqual([
        { type: "step-start", stepId: "persist-prepare", name: "准备保护操作" },
        { type: "step-fail", stepId: "persist-prepare", error: message },
        summary,
      ]);
      expect(historyMocks.recordFixSummary).toHaveBeenCalledTimes(1);
      expect(historyMocks.recordFixSummary).toHaveBeenCalledWith("persist-on", summary);
    } finally {
      await reader.cancel();
    }
    expect((await request()).status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.protect).toHaveBeenCalledTimes(1));
  });

  it("keeps an accepted execution failure on the persist step with a fatal summary", async () => {
    const origin = await baseUrl();
    const events = await fetch(`${origin}/api/events`, { headers: authHeaders, signal: AbortSignal.timeout(5000) });
    const reader = events.body!.getReader();
    const message = "Persist execution failed";
    runtimeMocks.protect.mockRejectedValueOnce(new Error(message));
    try {
      const response = await fetch(`${origin}/api/fix/on`, { method: "POST", headers: authHeaders });
      expect(response.status).toBe(202);
      const summary = { type: "summary", ok: 0, fail: 1, rolledBack: false, fatal: true };
      expect(await readStepEvents(reader)).toEqual([
        { type: "step-start", stepId: "persist", name: expect.any(String) },
        { type: "step-fail", stepId: "persist", error: message },
        summary,
      ]);
      expect(historyMocks.recordFixSummary).toHaveBeenCalledWith("persist-on", summary);
    } finally {
      await reader.cancel();
    }
  });

  it('holds the busy lock while resolving the target so a second request cannot overtake it', async () => {
    const origin = await baseUrl();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    systemMocks.read.mockImplementationOnce(async () => {
      started();
      await gate;
      return { timezone: 'America/Los_Angeles', offsetMinutes: -420 };
    });
    const first = fetch(`${origin}/api/fix/on?region=us`, { method: 'POST', headers: authHeaders });
    await entered;
    try {
      const second = await fetch(`${origin}/api/fix/on?region=us&level=deep&timezone=America%2FChicago`, { method: 'POST', headers: authHeaders });
      expect(second.status).toBe(409);
    } finally {
      release();
    }
    expect((await first).status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.protect).toHaveBeenCalledTimes(1));
  });

  it('offers validated city choices from the shared catalogue', async () => {
    const origin = await baseUrl();
    const response = await fetch(`${origin}/api/regions`, { headers: authHeaders });
    const body = await response.json();
    expect(body.regions.find((region: { code: string }) => region.code === 'us').timezones)
      .toContainEqual({ timezone: 'America/Los_Angeles', winTimezone: 'Pacific Standard Time', label: '洛杉矶（太平洋）' });
  });

  it('preserves the manually aligned Los Angeles timezone when the old target has only a country', async () => {
    systemMocks.read.mockResolvedValue({ timezone: 'America/Los_Angeles', offsetMinutes: -420 });
    const origin = await baseUrl();
    const response = await fetch(`${origin}/api/fix/on?region=us`, { method: 'POST', headers: authHeaders });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.protect).toHaveBeenCalledWith({ mode: 'standard', region: 'us', timezone: 'America/Los_Angeles' }));
  });

  it('accepts an explicit US city and rejects unsupported or cross-region timezones before mutation', async () => {
    const origin = await baseUrl();
    for (const timezone of ['', 'Asia/Tokyo', 'US/Pacific']) {
      const response = await fetch(`${origin}/api/fix/on?region=us&timezone=${encodeURIComponent(timezone)}`, { method: 'POST', headers: authHeaders });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { id: 'INVALID_TIMEZONE', code: 400 } });
      expect(runtimeMocks.protect).not.toHaveBeenCalled();
      expect(historyMocks.recordFixSummary).not.toHaveBeenCalled();
    }
    const response = await fetch(`${origin}/api/fix/on?region=us&timezone=America%2FLos_Angeles`, { method: 'POST', headers: authHeaders });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.protect).toHaveBeenCalledWith({ mode: 'standard', region: 'us', timezone: 'America/Los_Angeles' }));
  });

  it('returns invalid protection levels before accepting the operation and releases the lock', async () => {
    const origin = await baseUrl();
    const response = await fetch(`${origin}/api/fix/on?level=ultra`, { method: 'POST', headers: authHeaders });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { id: 'INVALID_PROTECTION_LEVEL', code: 400 } });
    expect(runtimeMocks.protect).not.toHaveBeenCalled();
    expect(historyMocks.recordFixSummary).not.toHaveBeenCalled();
    const next = await fetch(`${origin}/api/fix/on?region=us`, { method: 'POST', headers: authHeaders });
    expect(next.status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.protect).toHaveBeenCalledTimes(1));
  });

  it('returns the resolved local timezone so legacy state does not preselect New York', async () => {
    systemMocks.read.mockResolvedValue({ timezone: 'America/Los_Angeles', offsetMinutes: -420 });
    const origin = await baseUrl();
    const response = await fetch(`${origin}/api/status`, { headers: authHeaders });
    expect(await response.json()).toMatchObject({ currentTimezone: 'America/Los_Angeles', resolvedTimezone: 'America/Los_Angeles' });
  });

  it("defaults only a completely omitted region to US", async () => {
    const origin = await baseUrl();

    const response = await fetch(`${origin}/api/fix/on`, { method: "POST", headers: authHeaders });

    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.protect).toHaveBeenCalledTimes(1));
    expect(runtimeMocks.protect.mock.calls[0]?.[0]).toEqual({ mode: "standard", region: "us", timezone: 'America/New_York' });
  });

  it("initializes the persist runtime exactly once across status and fix requests (issue #44)", async () => {
    const origin = await baseUrl();
    let initCount = 0;
    const oldStatus = runtimeMocks.status;
    // baseUrl 已用过默认工厂；此用例重启一个带计数工厂的实例
    await closeServer();
    server = await startGuiServer(0, {
      createRuntime: async () => { initCount += 1; return runtimeMocks as never; },
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const origin2 = `http://127.0.0.1:${address.port}`;
    const bootstrap = await fetch(server.bootstrapUrl(), { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("no cookie");
    const headers = { Cookie: cookie };
    await Promise.all([
      fetch(`${origin2}/api/status`, { headers }),
      fetch(`${origin2}/api/fix/recover`, { method: "POST", headers: { ...headers, Origin: origin2 } }),
    ]);
    expect(initCount).toBe(1);
    await closeServer();
    server = await startGuiServer(0, { createRuntime: async () => runtimeMocks as never });
  });

  it("allows same-origin GET without an Origin header while the session cookie authenticates (issue #43)", async () => {
    const origin = await baseUrl();
    const status = await fetch(`${origin}/api/status`, { headers: { Cookie: authHeaders.Cookie } });
    expect(status.status).toBe(200);
    const regions = await fetch(`${origin}/api/regions`, { headers: { Cookie: authHeaders.Cookie } });
    expect(regions.status).toBe(200);
  });

  it("rejects a mismatched Origin on GET and requires Origin on POST (issue #43)", async () => {
    const origin = await baseUrl();
    const wrongOrigin = await fetch(`${origin}/api/status`, { headers: { Cookie: authHeaders.Cookie, Origin: "https://evil.example" } });
    expect(wrongOrigin.status).toBe(401);
    const noOriginPost = await fetch(`${origin}/api/fix/recover`, { method: "POST", headers: { Cookie: authHeaders.Cookie } });
    expect(noOriginPost.status).toBe(401);
    expect(runtimeMocks.recover).not.toHaveBeenCalled();
  });

  it("rejects empty and invalid regions without mutation or locking the next valid request", async () => {
    const origin = await baseUrl();

    for (const value of ["", "unknown"]) {
      const response = await fetch(`${origin}/api/fix/on?region=${value}`, { method: "POST", headers: authHeaders });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          id: "INVALID_REGION",
          code: 400,
          message: `Invalid explicit region; expected one of: us, eu, jp, sg`,
          source: "explicit",
          value,
          validRegions: ["us", "eu", "jp", "sg"],
        },
      });
      expect(runtimeMocks.protect).not.toHaveBeenCalled();
    }

    const validResponse = await fetch(`${origin}/api/fix/on?region=jp`, { method: "POST", headers: authHeaders });
    expect(validResponse.status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.protect).toHaveBeenCalledTimes(1));
    expect(runtimeMocks.protect.mock.calls[0]?.[0]).toEqual({ mode: "standard", region: "jp", timezone: 'Asia/Tokyo' });
  });

  it("broadcasts the running-browser hint over the SSE channel after a successful protect", async () => {
    browserMocks.detectRunningBrowsers.mockReturnValue(["chrome", "edge"]);
    const origin = await baseUrl();
    const eventsRes = await fetch(`${origin}/api/events`, { headers: authHeaders });
    const reader = eventsRes.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 5000;
    const readTask = (async () => {
      while (Date.now() < deadline && !text.includes("browser-hint")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    })();
    const response = await fetch(`${origin}/api/fix/on`, { method: "POST", headers: authHeaders });
    expect(response.status).toBe(202);
    await readTask;
    await reader.cancel();
    expect(text).toContain("catalog");
    expect(text).toContain("timezone");
    expect(text).toContain("browser-hint");
    expect(text).toContain("chrome");
    expect(text).toContain("edge");
  });

  it("broadcasts a degraded summary carrying unaligned slots without marking failure (issue #50)", async () => {
    runtimeMocks.protect.mockResolvedValueOnce({
      kind: "degraded",
      degraded: [
        { kind: "browser_policy_unaligned", slot: "edge.accept_language", cause: "access_denied" },
        { kind: "browser_policy_unaligned", slot: "edge.webrtc", cause: "access_denied" },
      ],
    });
    const origin = await baseUrl();
    const eventsRes = await fetch(`${origin}/api/events`, { headers: authHeaders });
    const reader = eventsRes.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 5000;
    const readTask = (async () => {
      while (Date.now() < deadline && !text.includes('"summary"')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    })();
    const response = await fetch(`${origin}/api/fix/on`, { method: "POST", headers: authHeaders });
    expect(response.status).toBe(202);
    await readTask;
    await reader.cancel();
    const summaryLine = text.split("\n").find((line) => line.startsWith("data: ") && line.includes('"summary"'));
    expect(summaryLine).toBeDefined();
    const summary = JSON.parse(summaryLine!.slice("data: ".length)) as {
      ok: number; fail: number; rolledBack: boolean; fatal: boolean; degraded?: string[];
    };
    expect(summary.ok).toBe(1);
    expect(summary.fail).toBe(0);
    expect(summary.rolledBack).toBe(false);
    expect(summary.fatal).toBe(false);
    expect(summary.degraded).toEqual(["edge.accept_language", "edge.webrtc"]);
  });

  it("accepts an explicit deep level and reports committed state status", async () => {
    const origin = await baseUrl();
    const response = await fetch(`${origin}/api/fix/on?region=sg&level=deep`, { method: "POST", headers: authHeaders });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.protect).toHaveBeenCalledWith({ mode: "deep", region: "sg", timezone: 'Asia/Singapore' }));
    const status = await fetch(`${origin}/api/status`, { headers: authHeaders });
    await expect(status.json()).resolves.toMatchObject({ mode: "daily", preferredRegion: "us", health: "healthy" });
  });

  it("exposes revision and updatedAt facts on the status payload (#111)", async () => {
    const origin = await baseUrl();
    const status = await fetch(`${origin}/api/status`, { headers: authHeaders });
    const payload = (await status.json()) as { revision: number; updatedAt: string; preferredRegion: string };
    expect(payload.revision).toBeGreaterThanOrEqual(0);
    expect(typeof payload.updatedAt).toBe("string");
    expect(typeof payload.preferredRegion).toBe("string");
  });

  it("serves the single-source version payload and requires a session (#112)", async () => {
    const origin = await baseUrl();
    expect((await fetch(`${origin}/api/version`)).status).toBe(401);
    const response = await fetch(`${origin}/api/version`, { headers: authHeaders });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { version: string; product: string };
    expect(payload.product).toBe("cc-fix");
    expect(payload.version).toMatch(/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/);
  });

  it("rejects missing sessions, hostile origins and bootstrap replay", async () => {
    const origin = await baseUrl();
    expect((await fetch(`${origin}/api/status`)).status).toBe(401);
    expect((await fetch(`${origin}/api/status`, { headers: { ...authHeaders, Origin: "https://evil.example" } })).status).toBe(401);
    const replay = await fetch(server!.bootstrapUrl(), { redirect: "manual" });
    expect(replay.status).toBe(401);
  });
});

describe("GET /assets/fonts", () => {
  it("serves the bundled CJK font with immutable same-origin caching", async () => {
    const origin = await baseUrl();
    const response = await fetch(`${origin}/assets/fonts/cc-fix-noto-sans-sc.woff2`, { headers: authHeaders });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("font/woff2");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("etag")).toBe('"C3BED59129B34D5F5B6BDCAE207748491DC0A919E4F0BBE8108B156BC7E9A2D9"');
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1024);
  });

  it("does not expose the asset without a local session", async () => {
    const origin = await baseUrl();
    const response = await fetch(`${origin}/assets/fonts/cc-fix-noto-sans-sc.woff2`);
    expect(response.status).toBe(401);
  });
});

describe("GET /assets/gui", () => {
  it("serves external stylesheet and script with precise MIME and a same-origin policy", async () => {
    const origin = await baseUrl();
    const [css, script, renderers, state, html] = await Promise.all([
      fetch(`${origin}/assets/gui/app.css`, { headers: authHeaders }),
      fetch(`${origin}/assets/gui/app.js`, { headers: authHeaders }),
      fetch(`${origin}/assets/gui/renderers.js`, { headers: authHeaders }),
      fetch(`${origin}/assets/gui/state.js`, { headers: authHeaders }),
      fetch(`${origin}/`, { headers: authHeaders }),
    ]);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("application/javascript");
    expect(script.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(renderers.status).toBe(200);
    expect(renderers.headers.get("content-type")).toContain("application/javascript");
    expect(state.status).toBe(200);
    expect(state.headers.get("content-type")).toContain("application/javascript");
    const csp = html.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    // #93：HTML/JSON/静态资源统一携带防嗅探与防引用泄漏头
    for (const response of [css, script, renderers, state, html]) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("adds nosniff and referrer-policy to JSON API responses (#93)", async () => {
    const origin = await baseUrl();
    const response = await fetch(`${origin}/api/regions`, { headers: authHeaders });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST /api/fonts/remove", () => {
  it("keeps destructive system-font removal disabled while restore remains available", async () => {
    const origin = await baseUrl();

    const response = await fetch(`${origin}/api/fonts/remove`, { method: "POST", headers: authHeaders });

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "font_removal_disabled",
      message: "中文字体移除功能已停用；已有备份仍可还原",
    });
  });
});
