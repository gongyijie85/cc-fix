import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories: string[] = [];
const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-fix-release-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runNodeScript(script: string, arguments_: string[] = []) {
  return spawnSync(process.execPath, [path.join(repositoryRoot, "scripts", script), ...arguments_], {
    encoding: "utf8",
  });
}

function resolvedToolchainLock() {
  return {
    schemaVersion: 1,
    releasePolicy: { unresolvedFields: "fail" },
    tools: {
      node: {
        version: "24.18.1",
        source: "https://nodejs.org/dist/v24.18.1/node-v24.18.1-win-x64.zip",
        sha256: digest,
      },
      rust: {
        version: "1.90.0",
        source: "https://static.rust-lang.org/dist/2026-08-01/rust-1.90.0-x86_64-pc-windows-msvc.tar.xz",
        sha256: digest,
      },
      tauri: {
        version: "2.11.5",
        source: "https://static.crates.io/crates/tauri/tauri-2.11.5.crate",
        sha256: digest,
      },
      innoSetup: {
        version: "6.7.3",
        source: "https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe",
        sha256: digest,
      },
      webView2: {
        version: "1.3.251.23",
        source: "https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/11111111-2222-3333-4444-555555555555/MicrosoftEdgeWebView2RuntimeInstallerX64.exe",
        sha256: digest,
      },
    },
  };
}

async function validateToolchain(lock: object) {
  const directory = await makeTemporaryDirectory();
  const lockPath = path.join(directory, "toolchain.lock.json");
  await writeFile(lockPath, JSON.stringify(lock), "utf8");
  return runNodeScript("validate-toolchain-lock.mjs", ["--lock", lockPath]);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("version consistency validator", () => {
  it("fails against a temporary legacy installer version drift", async () => {
    const fixtureRoot = await makeTemporaryDirectory();
    await mkdir(path.join(fixtureRoot, "src"));
    await mkdir(path.join(fixtureRoot, "scripts"));
    await writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify({ version: "0.2.0-rc.1" }));
    await writeFile(path.join(fixtureRoot, "src", "version.ts"), 'import packageJson from "../package.json";\nexport const version = packageJson.version;\nexport const buildMetadata = Object.freeze({ version });\n');
    await writeFile(path.join(fixtureRoot, "src", "index.ts"), 'import { version } from "./version.js";\nprogram.version(version);\n');
    await writeFile(path.join(fixtureRoot, "scripts", "install.ps1"), 'Write-Host "cc-fix v0.1.0"\n');

    const result = runNodeScript("check-version-consistency.mjs", ["--root", fixtureRoot]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/install.ps1 redeclares version literal(s): 0.1.0");
  });
});

describe("toolchain lock validator", () => {
  it("accepts a completely resolved exact lock", async () => {
    const result = await validateToolchain(resolvedToolchainLock());

    expect(result.status).toBe(0);
  });

  it.each([
    ["node", "24"],
    ["rust", "stable"],
    ["tauri", "2"],
    ["innoSetup", "6.7"],
    ["webView2", "evergreen"],
  ])("rejects a vague %s version", async (toolName, version) => {
    const lock = resolvedToolchainLock();
    lock.tools[toolName as keyof typeof lock.tools].version = version;

    const result = await validateToolchain(lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${toolName}.version`);
  });

  it("rejects a source URL that is not tied to its tool version", async () => {
    const lock = resolvedToolchainLock();
    lock.tools.node.source = "https://nodejs.org/downloads/";

    const result = await validateToolchain(lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("node.source");
  });

  it.each(["0".repeat(64), "0123456789abcdef".repeat(4)])("rejects a placeholder digest", async (sha256) => {
    const lock = resolvedToolchainLock();
    lock.tools.tauri.sha256 = sha256;

    const result = await validateToolchain(lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tauri.sha256");
  });

  it("rejects unexpected tool keys", async () => {
    const lock = resolvedToolchainLock() as ReturnType<typeof resolvedToolchainLock> & { tools: Record<string, unknown> };
    lock.tools.electron = { version: "1.0.0", source: "https://example.test/electron-1.0.0.zip", sha256: digest };

    const result = await validateToolchain(lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unexpected tool keys");
  });

  it("rejects an all-null tool map", async () => {
    const lock = resolvedToolchainLock() as ReturnType<typeof resolvedToolchainLock> & { tools: Record<string, unknown> };
    for (const toolName of Object.keys(lock.tools)) lock.tools[toolName] = null;

    const result = await validateToolchain(lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("node must be a non-null plain object");
  });

  it.each([["array", []], ["string", "invalid"], ["number", 42]])("rejects a %s tool entry", async (_kind, entry) => {
    const lock = resolvedToolchainLock() as ReturnType<typeof resolvedToolchainLock> & { tools: Record<string, unknown> };
    lock.tools.node = entry;

    const result = await validateToolchain(lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("node must be a non-null plain object");
  });

  it.each([
    ["schema version", (lock: Record<string, unknown>) => { lock.schemaVersion = 2; }, "schemaVersion must equal 1"],
    ["release policy", (lock: Record<string, unknown>) => { lock.releasePolicy = { unresolvedFields: "warn" }; }, "releasePolicy.unresolvedFields must equal fail"],
    ["root key", (lock: Record<string, unknown>) => { lock.extra = true; }, "unexpected root keys: extra"],
    ["release policy key", (lock: Record<string, unknown>) => { (lock.releasePolicy as Record<string, unknown>).extra = true; }, "unexpected releasePolicy keys: extra"],
    ["tool entry key", (lock: Record<string, unknown>) => { ((lock.tools as Record<string, unknown>).node as Record<string, unknown>).extra = true; }, "unexpected node keys: extra"],
    ["unresolved key", (lock: Record<string, unknown>) => {
      ((lock.tools as Record<string, unknown>).node as Record<string, unknown>).unresolved = { fields: ["sha256"], bootstrap: "Resolve it.", extra: true };
    }, "unexpected node.unresolved keys: extra"],
  ])("rejects an invalid %s", async (_kind, mutate, expectedError) => {
    const lock = resolvedToolchainLock() as unknown as Record<string, unknown>;
    mutate(lock);

    const result = await validateToolchain(lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expectedError);
  });
});

describe("publish helper", () => {
  it.each([
    "pnpm release:validate",
    "npm whoami",
    "pnpm typecheck",
    "pnpm test",
    "pnpm build",
    "npm pack --dry-run",
    "npm publish --access public",
    "npm view cc-fix version",
  ])("fails closed when `%s` fails", async (failedCommand) => {
    const fixtureRoot = await makeTemporaryDirectory();
    const scriptsDirectory = path.join(fixtureRoot, "scripts");
    const binDirectory = path.join(fixtureRoot, "bin");
    const logPath = path.join(fixtureRoot, "commands.log");
    await mkdir(scriptsDirectory);
    await mkdir(binDirectory);
    await writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify({ version: "0.2.0-rc.1" }));
    await writeFile(path.join(scriptsDirectory, "publish.ps1"), await readFile(path.join(repositoryRoot, "scripts", "publish.ps1"), "utf8"));

    const stub = '@echo off\r\n>> "%CC_FIX_COMMAND_LOG%" echo %~n0 %*\r\nif /I "%~n0 %*"=="%CC_FIX_FAIL_COMMAND%" exit /b 23\r\nexit /b 0\r\n';
    await writeFile(path.join(binDirectory, "pnpm.cmd"), stub);
    await writeFile(path.join(binDirectory, "npm.cmd"), stub);

    const result = spawnSync("powershell", ["-NoProfile", "-File", path.join(scriptsDirectory, "publish.ps1")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory};${process.env.PATH ?? ""}`,
        CC_FIX_COMMAND_LOG: logPath,
        CC_FIX_FAIL_COMMAND: failedCommand,
      },
    });
    const commands = (await readFile(logPath, "utf8")).trim().split(/\r?\n/);
    const allCommands = [
      "pnpm release:validate",
      "npm whoami",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
      "npm pack --dry-run",
      "npm publish --access public",
      "npm view cc-fix version",
    ];

    expect(result.status).not.toBe(0);
    expect(commands).toEqual(allCommands.slice(0, allCommands.indexOf(failedCommand) + 1));
  }, 60_000);
});

describe("release evidence verifier tamper fixtures (T28)", () => {
  async function fixtureEvidence(overrides: Partial<{
    installerBytes: Buffer;
    buildInfoVersion: string;
    checksumLine: string;
    sbomFormat: string;
    missing: "installer" | "build-info" | "checksum" | "sbom";
  }> = {}) {
    const root = await makeTemporaryDirectory();
    await mkdir(path.join(root, "release", "installer"), { recursive: true });
    await mkdir(path.join(root, "release", "evidence"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.2.0-rc.1" }), "utf8");

    const installerBytes = overrides.installerBytes ?? Buffer.from("fake installer payload for tamper tests", "utf8");
    const installerName = "CC-Fix-Setup-0.2.0-rc.1-x64.exe";
    await writeFile(path.join(root, "release", "installer", installerName), installerBytes);

    const digest = createHash("sha256").update(installerBytes).digest("hex");
    const buildInfoVersion = overrides.buildInfoVersion ?? "0.2.0-rc.1";
    await writeFile(
      path.join(root, "release", "evidence", "build-info.json"),
      JSON.stringify({ version: buildInfoVersion, installer: { sha256: digest } }),
      "utf8",
    );
    await writeFile(
      path.join(root, "release", "evidence", `${installerName}.sha256`),
      overrides.checksumLine ?? `${digest}  ${installerName}\n`,
      "utf8",
    );
    await writeFile(
      path.join(root, "release", "evidence", "sbom.cdx.json"),
      JSON.stringify({
        bomFormat: overrides.sbomFormat ?? "CycloneDX",
        specVersion: "1.5",
        components: [{ type: "application", name: "cc-fix", version: "0.2.0-rc.1" }],
      }),
      "utf8",
    );
    if (overrides.missing !== undefined) {
      const target = overrides.missing;
      const file = target === "installer"
        ? path.join(root, "release", "installer", installerName)
        : target === "build-info"
          ? path.join(root, "release", "evidence", "build-info.json")
          : target === "checksum"
            ? path.join(root, "release", "evidence", `${installerName}.sha256`)
            : path.join(root, "release", "evidence", "sbom.cdx.json");
      await rm(file, { force: true });
    }
    return root;
  }

  it("passes on an intact evidence set", async () => {
    const root = await fixtureEvidence();
    const result = runNodeScript("release/verify-evidence.mjs", ["--root", root]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Release evidence verified");
  });

  it("fails when the installer bytes are tampered after evidence was generated", async () => {
    const root = await fixtureEvidence();
    await writeFile(
      path.join(root, "release", "installer", "CC-Fix-Setup-0.2.0-rc.1-x64.exe"),
      Buffer.from("tampered installer bytes 12345", "utf8"),
    );
    const result = runNodeScript("release/verify-evidence.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("installer digest mismatch");
  });

  it("fails when the checksum file is tampered", async () => {
    const root = await fixtureEvidence({ checksumLine: "deadbeef".repeat(8) + "  CC-Fix-Setup-0.2.0-rc.1-x64.exe" });
    const result = runNodeScript("release/verify-evidence.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum file mismatch");
  });

  it("fails when build-info version drifts", async () => {
    const root = await fixtureEvidence({ buildInfoVersion: "0.2.0-rc.2" });
    const result = runNodeScript("release/verify-evidence.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("build-info version mismatch");
  });

  it("fails when the SBOM is tampered or empty", async () => {
    const root = await fixtureEvidence({ sbomFormat: "SPDX" });
    const result = runNodeScript("release/verify-evidence.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid or empty CycloneDX SBOM");
  });

  it("fails closed when evidence files are missing", async () => {
    for (const missing of ["installer", "build-info", "checksum", "sbom"] as const) {
      const root = await fixtureEvidence({ missing });
      const result = runNodeScript("release/verify-evidence.mjs", ["--root", root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unreadable");
    }
  });
});

describe("npm pre-publish verification (T29)", () => {
  async function fixturePackage(overrides: Partial<{
    files: string[];
    version: string;
    binOutput: string;
  }> = {}) {
    const root = await makeTemporaryDirectory();
    const version = overrides.version ?? "1.2.3-test";
    const files = overrides.files ?? ["dist"];
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "cc-fix", version, files, bin: { "cc-fix": "dist/index.js" } }),
      "utf8",
    );
    await mkdir(path.join(root, "dist"), { recursive: true });
    // 真实产物带 node shebang（tsup banner）；npm 对无 shebang 的 bin 在 Windows 生成不可直接执行的 shim。
    await writeFile(
      path.join(root, "dist", "index.js"),
      `#!/usr/bin/env node\nconsole.log("${overrides.binOutput ?? version}")\n`,
      "utf8",
    );
    return root;
  }

  it("passes on a well-formed package", async () => {
    const root = await fixturePackage();
    const result = runNodeScript("release/verify-npm.mjs", ["--root", root]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CC_FIX_NPM_OK");
  });

  it("fails when dist is missing from the files allowlist", async () => {
    const root = await fixturePackage({ files: ["README.md"] });
    const result = runNodeScript("release/verify-npm.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must include dist");
  });

  it("fails when the installed CLI reports a different version", async () => {
    const root = await fixturePackage({ binOutput: "9.9.9-wrong" });
    const result = runNodeScript("release/verify-npm.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("installed CLI version");
  }, 120_000);
});

