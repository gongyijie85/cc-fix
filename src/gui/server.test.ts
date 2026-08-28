import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  protect: vi.fn(async (): Promise<{ kind: string; degraded: Array<{ kind: string; slot: string; cause: string }> }> => ({ kind: "committable", degraded: [] })),
  restore: vi.fn(async () => ({ kind: "restored" })),
  recover: vi.fn(async () => ({ kind: "recovered", failed: [] })),
  status: vi.fn(async () => ({ mode: "daily", target: null, preferredRegion: "us", health: "healthy", transaction: { kind: "none" } })),
}));

vi.mock("./index.html", () => ({ default: "<!doctype html>" }));

const browserMocks = vi.hoisted(() => ({ detectRunningBrowsers: vi.fn<() => string[]>(() => []) }));

vi.mock("../platform/browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/browser.js")>();
  return { ...actual, detectRunningBrowsers: browserMocks.detectRunningBrowsers };
});

const ipIntelMocks = vi.hoisted(() => ({ fetcher: vi.fn(async () => null) }));

import { startGuiServer, type GuiHttpServer } from "./server.js";

let server: GuiHttpServer | undefined;
let authHeaders: Record<string, string> = {};

async function baseUrl(): Promise<string> {
  server = await startGuiServer(0, {
    createRuntime: async () => runtimeMocks as never,
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

beforeEach(() => {
  browserMocks.detectRunningBrowsers.mockClear();
  browserMocks.detectRunningBrowsers.mockReturnValue([]);
  runtimeMocks.protect.mockClear();
  runtimeMocks.restore.mockClear();
  runtimeMocks.recover.mockClear();
  runtimeMocks.status.mockClear();
  ipIntelMocks.fetcher.mockClear();
  ipIntelMocks.fetcher.mockResolvedValue(null);
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
  it("defaults only a completely omitted region to US", async () => {
    const origin = await baseUrl();

    const response = await fetch(`${origin}/api/fix/on`, { method: "POST", headers: authHeaders });

    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.protect).toHaveBeenCalledTimes(1));
    expect(runtimeMocks.protect.mock.calls[0]?.[0]).toEqual({ mode: "standard", region: "us" });
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
          code: "INVALID_REGION",
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
    expect(runtimeMocks.protect.mock.calls[0]?.[0]).toEqual({ mode: "standard", region: "jp" });
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
    await vi.waitFor(() => expect(runtimeMocks.protect).toHaveBeenCalledWith({ mode: "deep", region: "sg" }));
    const status = await fetch(`${origin}/api/status`, { headers: authHeaders });
    await expect(status.json()).resolves.toMatchObject({ mode: "daily", preferredRegion: "us", health: "healthy" });
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
