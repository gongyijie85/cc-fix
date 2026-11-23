import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  systemState: vi.fn(async () => ({ timezone: "America/Chicago", offsetMinutes: -360 })),
  resetSystemState: vi.fn(),
  fetchIp: vi.fn(async () => null),
  detect: vi.fn(async () => ({ score: 100 })),
  run: vi.fn(async () => 0),
  protect: vi.fn(async () => ({ kind: "noop" })),
}));

vi.mock("../platform/system-state.js", () => ({
  systemState: io.systemState, resetSystemState: io.resetSystemState,
}));
vi.mock("../proxy/ip-intel.js", () => ({ fetchIpIntelligence: io.fetchIp }));
vi.mock("../detection/runner.js", () => ({ runDetection: io.detect }));
vi.mock("../fix/history.js", () => ({ recordCheck: vi.fn(), recordPersistFacts: vi.fn() }));
vi.mock("../output/terminal.js", () => ({ renderCheckResponse: vi.fn(), renderJsonResponse: vi.fn() }));
vi.mock("../state/repository.js", () => ({
  StateRepository: class {
    async read() { return { value: { committedTarget: null, preferredRegion: "us" } }; }
  },
}));
vi.mock("../run/injector.js", () => ({ runWithInjectedEnv: io.run, runDesktop: vi.fn() }));
vi.mock("../persist/runtime.js", () => ({
  PersistRuntimeError: class extends Error {},
  createPersistRuntime: () => ({
    status: async () => ({
      mode: "standard", target: { mode: "standard", region: "us", timezone: "America/Denver" },
      preferredRegion: "us",
    }),
    protect: io.protect,
  }),
}));

const argv = process.argv;
const exitCode = process.exitCode;

async function runCli(...args: string[]) {
  process.argv = [process.execPath, "cc-fix", ...args];
  await import("../index.js");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

describe("CLI target resolution", () => {
  it("run starts an explicit city without reading the system timezone", async () => {
    await runCli("run", "--region", "us", "--timezone", "America/Los_Angeles", "--", "example");
    expect(io.run).toHaveBeenCalledWith("example", [], expect.objectContaining({ timezone: "America/Los_Angeles" }));
    expect(io.systemState).not.toHaveBeenCalled();
  });

  it("persist on reuses the committed city without reading the system timezone", async () => {
    await runCli("persist", "on", "--region", "us", "--json");
    expect(io.protect).toHaveBeenCalledWith({ mode: "standard", region: "us", timezone: "America/Denver" });
    expect(io.systemState).not.toHaveBeenCalled();
  });

  it("run resolves a single-city region without reading the system timezone", async () => {
    await runCli("run", "--region", "jp", "--", "example");
    expect(io.run).toHaveBeenCalledWith("example", [], expect.objectContaining({ timezone: "Asia/Tokyo" }));
    expect(io.systemState).not.toHaveBeenCalled();
  });

  it("check can start detection for an explicit city while its system probe is pending", async () => {
    let finish!: (value: { timezone: string; offsetMinutes: number }) => void;
    const pending = new Promise<{ timezone: string; offsetMinutes: number }>((resolve) => { finish = resolve; });
    io.systemState.mockReturnValueOnce(pending);
    const check = runCli("check", "--region", "us", "--timezone", "America/Denver");
    try {
      await vi.waitFor(() => expect(io.detect).toHaveBeenCalledWith(
        "auto", "America/Denver", "en_US.UTF-8", null, undefined, { reuseSystemState: true },
      ));
    } finally {
      finish({ timezone: "America/Chicago", offsetMinutes: -360 });
      await check;
    }
    expect(io.systemState).toHaveBeenCalledTimes(1);
  });

  it("check starts IP lookup while the local fallback is pending and reports target timing", async () => {
    let finish!: (value: { timezone: string; offsetMinutes: number }) => void;
    const pending = new Promise<{ timezone: string; offsetMinutes: number }>((resolve) => { finish = resolve; });
    const probeStarted = new Promise<void>((resolve) => {
      io.systemState.mockImplementationOnce(() => { resolve(); return pending; });
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const check = runCli("check", "--region", "us", "--debug");
    try {
      await Promise.race([probeStarted, check]);
      expect(io.systemState).toHaveBeenCalledTimes(1);
      expect(io.fetchIp).toHaveBeenCalledTimes(1);
      expect(io.detect).not.toHaveBeenCalled();
    } finally {
      finish({ timezone: "America/Chicago", offsetMinutes: -360 });
      await check;
    }
    expect(io.detect).toHaveBeenCalledWith("auto", "America/Chicago", "en_US.UTF-8", null, undefined, { reuseSystemState: true });
    expect(io.resetSystemState).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("check.target-selection"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("check.target-timezone"));
  });

  it.each([
    ["--region", "invalid"],
    ["--region", "us", "--timezone", "Asia/Tokyo"],
    ["--timezone", "Asia/Tokyo"],
  ])("check rejects invalid input %j before querying IP services", async (...args) => {
    await runCli("check", ...args, "--json");
    expect(process.exitCode).toBe(10);
    expect(io.fetchIp).not.toHaveBeenCalled();
    expect(io.resetSystemState).not.toHaveBeenCalled();
    expect(io.systemState).not.toHaveBeenCalled();
  });
});
