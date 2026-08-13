import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  protect: vi.fn(async () => ({ kind: "committable", degraded: [] })),
  restore: vi.fn(async () => ({ kind: "restored" })),
  status: vi.fn(async () => ({ mode: "daily", target: null, preferredRegion: "us", health: "healthy", transaction: { kind: "none" } })),
}));

vi.mock("./index.html", () => ({ default: "<!doctype html>" }));

import { startGuiServer } from "./server.js";

let server: Server | undefined;

async function baseUrl(): Promise<string> {
  server = await startGuiServer(0, { createRuntime: async () => runtimeMocks as never });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("GUI test server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
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
  runtimeMocks.protect.mockClear();
  runtimeMocks.restore.mockClear();
  runtimeMocks.status.mockClear();
});

afterEach(async () => {
  await closeServer();
});

describe("POST /api/fix/on region validation", () => {
  it("defaults only a completely omitted region to US", async () => {
    const origin = await baseUrl();

    const response = await fetch(`${origin}/api/fix/on`, { method: "POST" });

    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.protect).toHaveBeenCalledTimes(1));
    expect(runtimeMocks.protect.mock.calls[0]?.[0]).toEqual({ mode: "standard", region: "us" });
  });

  it("rejects empty and invalid regions without mutation or locking the next valid request", async () => {
    const origin = await baseUrl();

    for (const value of ["", "unknown"]) {
      const response = await fetch(`${origin}/api/fix/on?region=${value}`, { method: "POST" });
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

    const validResponse = await fetch(`${origin}/api/fix/on?region=jp`, { method: "POST" });
    expect(validResponse.status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.protect).toHaveBeenCalledTimes(1));
    expect(runtimeMocks.protect.mock.calls[0]?.[0]).toEqual({ mode: "standard", region: "jp" });
  });

  it("accepts an explicit deep level and reports committed state status", async () => {
    const origin = await baseUrl();
    const response = await fetch(`${origin}/api/fix/on?region=sg&level=deep`, { method: "POST" });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(runtimeMocks.protect).toHaveBeenCalledWith({ mode: "deep", region: "sg" }));
    const status = await fetch(`${origin}/api/status`);
    await expect(status.json()).resolves.toMatchObject({ mode: "daily", preferredRegion: "us", health: "healthy" });
  });
});
