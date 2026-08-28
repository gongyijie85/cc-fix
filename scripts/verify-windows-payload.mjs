import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const payloadRoot = path.resolve(repositoryRoot, "release", "payload");
const manifestPath = path.resolve(repositoryRoot, "release", "payload.sha256.json");
const writeMode = process.argv.includes("--write");

// #63 载荷门禁：自托管字体与 license 必须随包分发（fail-closed，禁止静默缺失）
const REQUIRED_PAYLOAD_FILES = [
  "core/index.js",
  "core/sidecar.js",
  "native/cc-fix-native-helper.exe",
  "native/cc-fix-native-helper.exe.sha256",
  "assets/fonts/cc-fix-noto-sans-sc.woff2",
  "assets/fonts/NOTICE.txt",
  "assets/fonts/OFL-1.1.txt",
  "assets/gui/app.css",
  "assets/gui/app.js",
  "assets/gui/renderers.js",
  "assets/gui/state.js",
];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(absolute) : [absolute];
  }));
  return nested.flat();
}

async function digest(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

let files;
try {
  files = (await filesBelow(payloadRoot))
    .map((absolute) => ({ absolute, relative: path.relative(payloadRoot, absolute).replaceAll("\\", "/") }))
    .filter(({ relative }) => relative !== "payload.sha256.json")
    .sort((left, right) => left.relative.localeCompare(right.relative));
} catch {
  files = [];
}
const present = new Set(files.map(({ relative }) => relative));
const missing = REQUIRED_PAYLOAD_FILES.filter((relative) => !present.has(relative));
if (missing.length > 0) {
  console.error(`Windows payload is missing required files (fail-closed):\n- ${missing.join("\n- ")}`);
  process.exitCode = 1;
}
const actual = Object.fromEntries(await Promise.all(files.map(async ({ absolute, relative }) => [relative, await digest(absolute)])));

if (writeMode) {
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, files: actual }, null, 2)}\n`, "utf8");
  console.log(`Wrote ${Object.keys(actual).length} payload digests`);
} else {
  const expected = JSON.parse(await readFile(manifestPath, "utf8"));
  if (expected.schemaVersion !== 1 || JSON.stringify(expected.files) !== JSON.stringify(actual)) {
    console.error("Windows payload does not match its SHA-256 manifest");
    process.exitCode = 1;
  } else {
    console.log(`Verified ${Object.keys(actual).length} payload digests`);
  }
}
