import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const versionSource = await readFile(path.join(repositoryRoot, "src", "version.ts"), "utf8");
const cliSource = await readFile(path.join(repositoryRoot, "src", "index.ts"), "utf8");
const installSource = await readFile(path.join(repositoryRoot, "scripts", "install.ps1"), "utf8");

const failures = [];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  failures.push(`package.json contains an invalid semantic version: ${packageJson.version}`);
}
if (!/import packageJson from ["']\.\.\/package\.json["']/.test(versionSource)) {
  failures.push("src/version.ts must import package.json as its version source");
}
if (!/export const version = packageJson\.version;/.test(versionSource)) {
  failures.push("src/version.ts must export packageJson.version without redeclaring it");
}
if (!/version,?\s*\n?\s*}\);/.test(versionSource)) {
  failures.push("build metadata must reference the runtime version export");
}
if (!/import { version } from ["']\.\/version\.js["']/.test(cliSource) || !/\.version\(version\)/.test(cliSource)) {
  failures.push("the CLI must pass the shared runtime version to Commander");
}

const declaredSemver = /(?<![\d.])\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?![\d.])/g;
for (const [name, source] of [
  ["src/version.ts", versionSource],
  ["src/index.ts", cliSource],
  ["scripts/install.ps1", installSource],
]) {
  const duplicates = source.match(declaredSemver) ?? [];
  if (duplicates.length > 0) {
    failures.push(`${name} redeclares version literal(s): ${duplicates.join(", ")}`);
  }
}

if (failures.length > 0) {
  console.error(`Version consistency check failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Version consistency check passed: ${packageJson.version}`);
}
