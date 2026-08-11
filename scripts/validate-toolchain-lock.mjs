import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(path.join(repositoryRoot, "toolchain.lock.json"), "utf8"));
const failures = [];
const expectedTools = ["node", "rust", "tauri", "innoSetup", "webView2"];

for (const name of expectedTools) {
  const tool = lock.tools?.[name];
  if (!tool) {
    failures.push(`${name} is missing`);
    continue;
  }
  const unresolvedFields = new Set(tool.unresolved?.fields ?? []);
  for (const field of ["version", "source", "sha256"]) {
    if (unresolvedFields.has(field)) {
      failures.push(`${name}.${field} is explicitly unresolved: ${tool.unresolved.bootstrap}`);
    } else if (typeof tool[field] !== "string" || tool[field].length === 0) {
      failures.push(`${name}.${field} is unresolved`);
    }
  }
  if (tool.sha256 && !/^[a-f0-9]{64}$/i.test(tool.sha256)) {
    failures.push(`${name}.sha256 is not a SHA-256 digest`);
  }
  if (unresolvedFields.size > 0 && (typeof tool.unresolved?.bootstrap !== "string" || tool.unresolved.bootstrap.length === 0)) {
    failures.push(`${name} unresolved fields require bootstrap instructions`);
  }
}

if (Object.keys(lock.tools ?? {}).length !== expectedTools.length) {
  failures.push("toolchain lock must contain Node, Rust, Tauri, Inno Setup, and WebView2");
}

if (failures.length > 0) {
  console.error(`Release toolchain validation failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("Release toolchain validation passed");
}
