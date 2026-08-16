// CI 门禁：运行时依赖漏洞检查（T27）。fail-closed——审计不可用即失败。
// 默认执行 `pnpm audit --prod --json`；测试/离线场景可用 --audit <npm-audit-json> 注入审计结果。
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseAudit(input) {
  const parsed = JSON.parse(input);
  const metadata = parsed.metadata ?? parsed;
  const counts = metadata.vulnerabilities ?? {
    info: 0, low: 0, moderate: 0, high: 0, critical: 0,
  };
  return {
    critical: Number(counts.critical ?? 0),
    high: Number(counts.high ?? 0),
    moderate: Number(counts.moderate ?? 0),
    low: Number(counts.low ?? 0),
    info: Number(counts.info ?? 0),
  };
}

async function auditFromFile(filePath) {
  try {
    return parseAudit(await readFile(filePath, "utf8"));
  } catch (error) {
    console.error(`CC_FIX_VULN_UNAVAILABLE: cannot read audit fixture ${filePath}: ${error instanceof Error ? error.message : String(error)}; gate fails closed`);
    process.exit(1);
  }
}

const auditArgument = process.argv.indexOf("--audit");
let counts;
if (auditArgument >= 0) {
  counts = await auditFromFile(path.resolve(process.argv[auditArgument + 1]));
} else {
  // Windows 下 pnpm 是 .cmd shim，需经 cmd.exe 包装执行。
  const command = process.platform === "win32" ? "cmd.exe" : "pnpm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "pnpm audit --prod --json"]
    : ["audit", "--prod", "--json"];
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  if (result.status === null) {
    console.error(`CC_FIX_VULN_UNAVAILABLE: audit could not run (${result.error?.message ?? "spawn failed"}); gate fails closed`);
    process.exit(1);
  }
  try {
    counts = parseAudit(output || "{}");
  } catch {
    console.error("CC_FIX_VULN_UNAVAILABLE: audit produced no parseable JSON (network or registry failure); gate fails closed");
    process.exit(1);
  }
}

const blocking = counts.critical + counts.high;
if (blocking > 0) {
  console.error(`CC_FIX_VULN_FAIL: ${blocking} blocking runtime vulnerability(ies) (critical=${counts.critical}, high=${counts.high})`);
  process.exitCode = 1;
} else {
  console.log(`CC_FIX_VULN_OK: no critical/high runtime vulnerabilities (moderate=${counts.moderate}, low=${counts.low}, info=${counts.info})`);
}
