import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockArgument = process.argv.indexOf("--lock");
const lockPath = lockArgument >= 0
  ? path.resolve(process.argv[lockArgument + 1])
  : path.join(repositoryRoot, "toolchain.lock.json");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
const failures = [];
const expectedTools = ["node", "rust", "tauri", "innoSetup", "webView2"];
const exactVersionPatterns = {
  node: /^24\.\d+\.\d+$/,
  rust: /^\d+\.\d+\.\d+$/,
  tauri: /^2\.\d+\.\d+$/,
  innoSetup: /^6\.7\.\d+$/,
  webView2: /^\d+\.\d+\.\d+\.\d+$/,
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isExactArtifactSource(name, version, source) {
  if (typeof version !== "string" || typeof source !== "string") return false;

  let url;
  try {
    url = new URL(source);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.search || url.hash) return false;

  const escapedVersion = escapeRegExp(version);
  switch (name) {
    case "node":
      return source === `https://nodejs.org/dist/v${version}/node-v${version}-win-x64.zip`;
    case "rust":
      return new RegExp(`^https://static\\.rust-lang\\.org/dist/\\d{4}-\\d{2}-\\d{2}/rust-${escapedVersion}-x86_64-pc-windows-msvc\\.tar\\.xz$`).test(source);
    case "tauri":
      return source === `https://static.crates.io/crates/tauri/tauri-${version}.crate`;
    case "innoSetup":
      return source === `https://files.jrsoftware.org/is/6/innosetup-${version}.exe`;
    case "webView2":
      return /(^|\.)microsoft\.com$/i.test(url.hostname)
        && /webview2/i.test(url.pathname)
        && new RegExp(`(?:^|[^0-9])${escapedVersion}(?:[^0-9]|$)`).test(url.pathname)
        && url.pathname.toLowerCase().endsWith(".exe");
    default:
      return false;
  }
}

function isPlaceholderDigest(value) {
  const normalized = value.toLowerCase();
  for (let period = 1; period <= 16; period += 1) {
    if (normalized.length % period === 0 && normalized === normalized.slice(0, period).repeat(normalized.length / period)) {
      return true;
    }
  }
  return false;
}

const actualTools = Object.keys(lock.tools ?? {});
const missingTools = expectedTools.filter((name) => !actualTools.includes(name));
const unexpectedTools = actualTools.filter((name) => !expectedTools.includes(name));
if (missingTools.length > 0) failures.push(`missing tool keys: ${missingTools.join(", ")}`);
if (unexpectedTools.length > 0) failures.push(`unexpected tool keys: ${unexpectedTools.join(", ")}`);

for (const name of expectedTools) {
  const tool = lock.tools?.[name];
  if (!tool) continue;

  const unresolvedFields = new Set(tool.unresolved?.fields ?? []);
  for (const field of unresolvedFields) {
    if (!["version", "source", "sha256"].includes(field)) {
      failures.push(`${name}.${field} is explicitly unresolved: ${tool.unresolved.bootstrap}`);
    }
  }
  for (const field of ["version", "source", "sha256"]) {
    if (unresolvedFields.has(field)) {
      failures.push(`${name}.${field} is explicitly unresolved: ${tool.unresolved.bootstrap}`);
    } else if (typeof tool[field] !== "string" || tool[field].length === 0) {
      failures.push(`${name}.${field} is unresolved`);
    }
  }
  if (unresolvedFields.size > 0 && (typeof tool.unresolved?.bootstrap !== "string" || tool.unresolved.bootstrap.length === 0)) {
    failures.push(`${name} unresolved fields require bootstrap instructions`);
  }

  if (!unresolvedFields.has("version") && typeof tool.version === "string" && !exactVersionPatterns[name].test(tool.version)) {
    failures.push(`${name}.version is not an allowed exact version`);
  }
  if (!unresolvedFields.has("source") && !unresolvedFields.has("version") && !isExactArtifactSource(name, tool.version, tool.source)) {
    failures.push(`${name}.source is not an immutable artifact URL tied to ${tool.version}`);
  }
  if (!unresolvedFields.has("sha256") && typeof tool.sha256 === "string") {
    if (!/^[a-f0-9]{64}$/i.test(tool.sha256) || isPlaceholderDigest(tool.sha256)) {
      failures.push(`${name}.sha256 is not a non-placeholder SHA-256 digest`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Release toolchain validation failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("Release toolchain validation passed");
}
