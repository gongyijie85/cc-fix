// CI 门禁：许可证检查（T27）。fail-closed——未知/缺失许可证即失败。
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootArgument = process.argv.indexOf("--root");
const repositoryRoot = rootArgument >= 0
  ? path.resolve(process.argv[rootArgument + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const allowArgument = process.argv.indexOf("--allow");
const extraAllow = allowArgument >= 0
  ? process.argv[allowArgument + 1].split(",").map((value) => value.trim()).filter(Boolean)
  : [];

const ALLOWED_LICENSES = new Set([
  "MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD",
  "Unlicense", "CC0-1.0", "WTFPL", "Python-2.0",
  ...extraAllow,
]);

function licenseIds(metadata) {
  const license = metadata.license;
  if (license === undefined) return [];
  if (typeof license === "string") {
    // SPDX 双许可证表达式："Apache-2.0 OR MIT" → 两个备选都必须允许。
    if (license.includes(" OR ")) {
      return license.split(" OR ").map((value) => value.trim()).filter(Boolean);
    }
    return [license];
  }
  if (Array.isArray(license)) return license.flatMap((entry) => licenseIds(entry));
  if (typeof license === "object" && license !== null) {
    if (typeof license.type === "string") return [license.type];
    if (Array.isArray(license.licenses)) return license.licenses.flatMap((entry) => licenseIds(entry));
  }
  return [];
}

const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const declared = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
const names = Object.keys(declared);
const failures = [];
let checked = 0;

for (const name of names) {
  const metadataPath = path.join(repositoryRoot, "node_modules", name, "package.json");
  let metadata;
  try {
    await access(metadataPath);
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    failures.push(`${name}@${declared[name]}: package metadata missing (cannot verify license; fail closed)`);
    continue;
  }
  const ids = licenseIds(metadata);
  checked += 1;
  if (ids.length === 0) {
    failures.push(`${name}@${metadata.version}: no license declared; fail closed`);
    continue;
  }
  const unknown = ids.filter((id) => !ALLOWED_LICENSES.has(id));
  if (unknown.length > 0) {
    failures.push(`${name}@${metadata.version}: license(s) not in allowlist: ${unknown.join(", ")}`);
  }
}

if (failures.length > 0) {
  console.error(`CC_FIX_LICENSES_FAIL: ${failures.length} issue(s)\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`CC_FIX_LICENSES_OK: ${checked} declared components verified against allowlist`);
}
