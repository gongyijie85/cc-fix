import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  protect: vi.fn(async () => ({ kind: "committable", degraded: [] })),
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

import { startGuiServer, type GuiHttpServer } from "./server.js";

let server: GuiHttpServer | undefined;
let authHeaders: Record<string, string> = {};

async function baseUrl(): Promise<string> {
  server = await startGuiServer(0, { createRuntime: async () => runtimeMocks as never });
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
});

describe("POST /api/fix/recover", () => {
  it("routes recovery through the single application service", async () => {
    const origin = await baseUrl();
    const response = await fetch(`${origin}/api/fix/recover`, { method: "POST", headers: authHeaders });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.recover).toHaveBeenCalledTimes(1));
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
