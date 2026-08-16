// CI 门禁脚本测试（T27）：license / vuln / secret / version 四门禁 fail-closed 行为。
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-fix-ci-gates-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runCiScript(name: string, arguments_: string[] = []) {
  return spawnSync(process.execPath, [path.join(repositoryRoot, "scripts", "ci", name), ...arguments_], {
    encoding: "utf8",
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("check-licenses.mjs (T27)", () => {
  async function fixture(deps: Record<string, { license?: string; version?: string }>) {
    const root = await makeTemporaryDirectory();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: Object.fromEntries(Object.entries(deps).map(([name]) => [name, "1.0.0"])) }),
      "utf8",
    );
    for (const [name, metadata] of Object.entries(deps)) {
      const dir = path.join(root, "node_modules", name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version: metadata.version ?? "1.0.0", license: metadata.license }), "utf8");
    }
    return root;
  }

  it("passes when every declared dependency carries an allowlisted license", async () => {
    const root = await fixture({ chalk: { license: "MIT" }, "cli-table3": { license: "MIT" } });
    const result = runCiScript("check-licenses.mjs", ["--root", root]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CC_FIX_LICENSES_OK");
  });

  it("fails closed on an unknown license", async () => {
    const root = await fixture({ good: { license: "MIT" }, bad: { license: "Proprietary" } });
    const result = runCiScript("check-licenses.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CC_FIX_LICENSES_FAIL");
    expect(result.stderr).toContain("bad@1.0.0");
  });

  it("fails closed when license metadata is missing", async () => {
    const root = await fixture({ good: { license: "MIT" }, undeclared: {} });
    const result = runCiScript("check-licenses.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no license declared");
  });

  it("fails closed when a declared package is not installed", async () => {
    const root = await fixture({ ghost: { license: "MIT" } });
    await rm(path.join(root, "node_modules", "ghost"), { recursive: true, force: true });
    const result = runCiScript("check-licenses.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot verify license");
  });

  it("accepts SPDX dual-license OR expressions when both alternatives are allowed", async () => {
    const root = await fixture({ dual: { license: "Apache-2.0 OR MIT" } });
    const result = runCiScript("check-licenses.mjs", ["--root", root]);
    expect(result.status).toBe(0);
  });

  it("rejects SPDX OR expressions containing a disallowed alternative", async () => {
    const root = await fixture({ dual: { license: "MIT OR Proprietary" } });
    const result = runCiScript("check-licenses.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Proprietary");
  });

  it("honors --allow extra license", async () => {
    const root = await fixture({ custom: { license: "BUSL-1.1" } });
    const result = runCiScript("check-licenses.mjs", ["--root", root, "--allow", "BUSL-1.1"]);
    expect(result.status).toBe(0);
  });
});

describe("check-runtime-vulns.mjs (T27)", () => {
  async function auditFixture(counts: Record<string, number>) {
    const root = await makeTemporaryDirectory();
    const file = path.join(root, "audit.json");
    await writeFile(file, JSON.stringify({ metadata: { vulnerabilities: counts } }), "utf8");
    return file;
  }

  it("passes with only moderate/low findings", async () => {
    const file = await auditFixture({ info: 1, low: 2, moderate: 1, high: 0, critical: 0 });
    const result = runCiScript("check-runtime-vulns.mjs", ["--audit", file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CC_FIX_VULN_OK");
  });

  it("fails closed on critical/high findings", async () => {
    const file = await auditFixture({ info: 0, low: 0, moderate: 0, high: 1, critical: 0 });
    const result = runCiScript("check-runtime-vulns.mjs", ["--audit", file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CC_FIX_VULN_FAIL");
  });

  it("fails closed when the audit fixture is unreadable", async () => {
    const result = runCiScript("check-runtime-vulns.mjs", ["--audit", path.join("Z:\\missing", "audit.json")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CC_FIX_VULN_UNAVAILABLE");
  });

  it("fails closed on unparseable audit output", async () => {
    const root = await makeTemporaryDirectory();
    const file = path.join(root, "audit.json");
    await writeFile(file, "not json at all", "utf8");
    const result = runCiScript("check-runtime-vulns.mjs", ["--audit", file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CC_FIX_VULN_UNAVAILABLE");
  });
});

describe("check-secrets.mjs (T27)", () => {
  it("passes on a clean tree", async () => {
    const root = await makeTemporaryDirectory();
    await writeFile(path.join(root, "clean.txt"), "const region = \"us\";\n", "utf8");
    const result = runCiScript("check-secrets.mjs", ["--root", root]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CC_FIX_SECRETS_OK");
  });

  it("fails on a GitHub token pattern with file and line", async () => {
    // token 由两段拼接而成：仓库源码不含完整字面量，门禁扫描源码时不会误报。
    const token = "ghp_" + "AbCdEf0123456789AbCdEf0123456789AbCdEf01";
    const root = await makeTemporaryDirectory();
    await writeFile(path.join(root, "leak.txt"), `line one\nconst token = \"${token}\";\n`, "utf8");
    const result = runCiScript("check-secrets.mjs", ["--root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CC_FIX_SECRETS_FAIL");
    expect(result.stderr).toContain("leak.txt:2");
    expect(result.stderr).toContain("github-token");
  });

  it("honors --allow substrings", async () => {
    const token = "ghp_" + "AllowMe0123456789AllowMe0123456789AllowMe00";
    const root = await makeTemporaryDirectory();
    await writeFile(path.join(root, "fixture.txt"), `const fixture = \"${token}\";\n`, "utf8");
    const result = runCiScript("check-secrets.mjs", ["--root", root, "--allow", token]);
    expect(result.status).toBe(0);
  });
});
