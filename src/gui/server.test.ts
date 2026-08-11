import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flowMocks = vi.hoisted(() => ({
  persistOnFlow: vi.fn(async () => undefined),
  persistOffFlow: vi.fn(async () => undefined),
}));

vi.mock("../fix/flow.js", () => flowMocks);
vi.mock("./index.html", () => ({ default: "<!doctype html>" }));

import { startGuiServer } from "./server.js";

let server: Server | undefined;

async function baseUrl(): Promise<string> {
  server = await startGuiServer(0);
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
  flowMocks.persistOnFlow.mockClear();
  flowMocks.persistOffFlow.mockClear();
});

afterEach(async () => {
  await closeServer();
});

describe("POST /api/fix/on region validation", () => {
  it("defaults only a completely omitted region to US", async () => {
    const origin = await baseUrl();

    const response = await fetch(`${origin}/api/fix/on`, { method: "POST" });

    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(flowMocks.persistOnFlow).toHaveBeenCalledTimes(1));
    expect(flowMocks.persistOnFlow.mock.calls[0]?.[0]).toMatchObject({ regionCode: "us" });
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
      expect(flowMocks.persistOnFlow).not.toHaveBeenCalled();
    }

    const validResponse = await fetch(`${origin}/api/fix/on?region=jp`, { method: "POST" });
    expect(validResponse.status).toBe(202);
    await vi.waitFor(() => expect(flowMocks.persistOnFlow).toHaveBeenCalledTimes(1));
    expect(flowMocks.persistOnFlow.mock.calls[0]?.[0]).toMatchObject({ regionCode: "jp" });
  });
});
