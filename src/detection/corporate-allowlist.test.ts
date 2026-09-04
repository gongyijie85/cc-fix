import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isCorporateAsn,
  isCorporateIp,
  resetCorporateAllowlistCache,
} from "./corporate-allowlist.js";

// #91 回归 + 匹配语义：候选解析不得受不可信 CWD 影响；白名单只读固定/显式路径。
function fixtureAllowlist(cidrs: string[], asns: string[]): string {
  return JSON.stringify({ allowCidrs: cidrs, allowAsns: asns.map((a) => `AS${a}`) });
}

async function fixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cc-fix-allowlist-"));
}

async function writeAllowlist(target: string, cidrs: string[], asns: string[]): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, fixtureAllowlist(cidrs, asns), "utf8");
}

function withEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  resetCorporateAllowlistCache();
  withEnv({ CC_FIX_CORPORATE_ALLOWLIST: undefined, APPDATA: undefined });
});

describe("allowlist source resolution (issue #91)", () => {
  it("never consults a poisoned file in the working directory", async () => {
    const evilDir = await fixtureDir();
    // 若实现仍按 process.cwd() 解析，此文件会把任意 IP/ASN 判为企业内网。
    await writeAllowlist(
      join(evilDir, "vpn-anthropic-coexist", "src", "ccfix-bridge", "allowlist.json"),
      ["0.0.0.0/0"],
      ["99999"],
    );
    const prevCwd = process.cwd();
    process.chdir(evilDir);
    try {
      withEnv({ APPDATA: undefined, CC_FIX_CORPORATE_ALLOWLIST: undefined });
      resetCorporateAllowlistCache();
      await expect(isCorporateIp("8.8.8.8")).resolves.toBe(false);
      await expect(isCorporateAsn("AS99999")).resolves.toBe(false);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("honors an explicit absolute CC_FIX_CORPORATE_ALLOWLIST override", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "override.json");
    await writeFile(file, fixtureAllowlist(["8.8.8.8/32"], ["99999"]), "utf8");
    withEnv({ APPDATA: undefined, CC_FIX_CORPORATE_ALLOWLIST: file });
    resetCorporateAllowlistCache();
    await expect(isCorporateIp("8.8.8.8")).resolves.toBe(true);
    await expect(isCorporateIp("1.1.1.1")).resolves.toBe(false);
    await expect(isCorporateAsn("AS99999")).resolves.toBe(true);
    await expect(isCorporateAsn("AS1")).resolves.toBe(false);
  });

  it("prefers the %APPDATA% user file over the env override", async () => {
    const dir = await fixtureDir();
    const userFile = join(dir, "cc-fix", "corporate-allowlist.json");
    const envFile = join(dir, "env.json");
    await writeAllowlist(userFile, ["9.9.9.9/32"], ["11111"]);
    await writeAllowlist(envFile, ["8.8.8.8/32"], ["99999"]);
    withEnv({ APPDATA: dir, CC_FIX_CORPORATE_ALLOWLIST: envFile });
    resetCorporateAllowlistCache();
    await expect(isCorporateIp("9.9.9.9")).resolves.toBe(true);
    await expect(isCorporateIp("8.8.8.8")).resolves.toBe(false);
    await expect(isCorporateAsn("AS11111")).resolves.toBe(true);
    await expect(isCorporateAsn("AS99999")).resolves.toBe(false);
  });

  it("rejects a relative env path and falls through to builtin defaults", async () => {
    withEnv({ APPDATA: undefined, CC_FIX_CORPORATE_ALLOWLIST: "relative/allowlist.json" });
    resetCorporateAllowlistCache();
    await expect(isCorporateIp("10.1.2.3")).resolves.toBe(true); // 内置 RFC1918
    await expect(isCorporateIp("8.8.8.8")).resolves.toBe(false);
  });

  it("skips a malformed user file and falls through to the next candidate", async () => {
    const dir = await fixtureDir();
    const userFile = join(dir, "cc-fix", "corporate-allowlist.json");
    await mkdir(dirname(userFile), { recursive: true });
    await writeFile(userFile, "{not json", "utf8");
    const envFile = join(dir, "env.json");
    await writeAllowlist(envFile, ["8.8.8.8/32"], ["99999"]);
    withEnv({ APPDATA: dir, CC_FIX_CORPORATE_ALLOWLIST: envFile });
    resetCorporateAllowlistCache();
    await expect(isCorporateIp("8.8.8.8")).resolves.toBe(true);
    await expect(isCorporateAsn("AS99999")).resolves.toBe(true);
  });
});

describe("allowlist matching semantics", () => {
  it("matches IPv4 CIDR with correct host-mask semantics", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "c.json");
    await writeFile(file, fixtureAllowlist(["192.168.1.0/24", "10.0.0.0/8"], []), "utf8");
    withEnv({ APPDATA: undefined, CC_FIX_CORPORATE_ALLOWLIST: file });
    resetCorporateAllowlistCache();
    await expect(isCorporateIp("192.168.1.1")).resolves.toBe(true);
    await expect(isCorporateIp("192.168.1.255")).resolves.toBe(true);
    await expect(isCorporateIp("192.168.2.1")).resolves.toBe(false);
    await expect(isCorporateIp("10.255.255.255")).resolves.toBe(true);
    await expect(isCorporateIp("11.0.0.1")).resolves.toBe(false);
  });

  it("treats IPv6 as not-corporate-by-CIDR and rejects malformed inputs", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "c.json");
    await writeFile(file, fixtureAllowlist(["0.0.0.0/0"], []), "utf8");
    withEnv({ APPDATA: undefined, CC_FIX_CORPORATE_ALLOWLIST: file });
    resetCorporateAllowlistCache();
    await expect(isCorporateIp("2001:db8::1")).resolves.toBe(false);
    await expect(isCorporateIp(null)).resolves.toBe(false);
    await expect(isCorporateIp("999.1.1.1")).resolves.toBe(false);
  });

  it("normalizes ASN spellings on load; inputs require an AS prefix", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "c.json");
    await writeAllowlist(file, [], ["4134"]);
    withEnv({ APPDATA: undefined, CC_FIX_CORPORATE_ALLOWLIST: file });
    resetCorporateAllowlistCache();
    await expect(isCorporateAsn("AS4134")).resolves.toBe(true);
    await expect(isCorporateAsn("as4134")).resolves.toBe(true);
    // 裸数字不会匹配；带前缀的宽松文本按前缀提取命中（既有语义，容忍 "AS4134 - China Telecom" 来源）
    await expect(isCorporateAsn("4134")).resolves.toBe(false);
    await expect(isCorporateAsn("AS4134x")).resolves.toBe(true);
    await expect(isCorporateAsn(null)).resolves.toBe(false);
  });
});
