import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "toolchain.lock.json"), "utf8"));
const evidenceRoot = path.join(root, "release", "evidence");
const installerName = `CC-Fix-Setup-${packageJson.version}-x64.exe`;
const installerPath = path.join(root, "release", "installer", installerName);
const payloadManifestBytes = await readFile(path.join(root, "release", "payload.sha256.json"));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
const gitCommit = run("git", ["rev-parse", "HEAD"]);
const dirty = run("git", ["status", "--porcelain"]).length > 0;
const installerSha256 = sha256(await readFile(installerPath));

function cargoComponents(manifest) {
  const metadata = JSON.parse(run("cargo", ["metadata", "--locked", "--format-version", "1", "--manifest-path", manifest]));
  return metadata.packages.map((pkg) => ({
    type: "library",
    name: pkg.name,
    version: pkg.version,
    purl: `pkg:cargo/${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}`,
    licenses: pkg.license ? [{ license: { id: pkg.license } }] : undefined,
  }));
}

const npmComponents = await Promise.all(Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies }).map(async (name) => {
  const metadata = JSON.parse(await readFile(path.join(root, "node_modules", name, "package.json"), "utf8"));
  return {
    type: "library",
    name,
    version: metadata.version,
    purl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(metadata.version)}`,
    licenses: metadata.license ? [{ license: { id: metadata.license } }] : undefined,
  };
}));
const components = [...npmComponents, ...cargoComponents("native-helper/Cargo.toml"), ...cargoComponents("src-tauri/Cargo.toml")]
  .filter((component, index, all) => all.findIndex((candidate) => candidate.purl === component.purl) === index)
  .sort((left, right) => left.purl.localeCompare(right.purl));

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: "application", name: "cc-fix", version: packageJson.version },
  },
  components,
};
const buildInfo = {
  schemaVersion: 1,
  product: "CC-Fix",
  version: packageJson.version,
  commit: gitCommit,
  sourceTreeDirty: dirty,
  platform: process.platform,
  architecture: process.arch,
  toolchain: lock.tools,
  installer: { file: installerName, sha256: installerSha256 },
  payloadManifestSha256: sha256(payloadManifestBytes),
  signing: {
    status: process.env.CC_FIX_SIGNING_STATUS === "signed" ? "signed" : "unsigned",
    warning: process.env.CC_FIX_SIGNING_STATUS === "signed" ? null : "此候选包未进行 Authenticode 签名，Windows SmartScreen 可能显示警告。",
  },
};
const fontNotice = await readFile(path.join(root, "assets", "fonts", "NOTICE.txt"), "utf8");
const fontLicense = await readFile(path.join(root, "assets", "fonts", "OFL-1.1.txt"), "utf8");
const notices = [
  "# Third-party notices",
  "",
  "CC-Fix bundles Node.js, Microsoft Edge WebView2 Runtime, Tauri and their transitive dependencies.",
  "The exact vendor artifacts and SHA-256 digests are recorded in toolchain.lock.json.",
  "",
  ...components.map((component) => `- ${component.name} ${component.version}${component.licenses?.[0]?.license?.id ? ` — ${component.licenses[0].license.id}` : ""}`),
  "",
  "## Noto Sans CJK SC subset (bundled font)",
  "",
  fontNotice.trim(),
  "",
  fontLicense.trim(),
  "",
].join("\n");

await mkdir(evidenceRoot, { recursive: true });
await writeFile(path.join(evidenceRoot, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);
await writeFile(path.join(evidenceRoot, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
await writeFile(path.join(evidenceRoot, "THIRD-PARTY-NOTICES.md"), notices);
await writeFile(path.join(evidenceRoot, `${installerName}.sha256`), `${installerSha256}  ${installerName}\n`);
console.log(`Release evidence created for ${installerName} (${components.length} components)`);
