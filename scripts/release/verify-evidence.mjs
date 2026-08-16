// 发布证据验证：installer 摘要、build-info、checksum 文件、SBOM 结构一致性。
// 支持 --root <dir>（指向含 release/installer 与 release/evidence 的根），供 tamper fixture 测试。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootArgument = process.argv.indexOf("--root");
const root = rootArgument >= 0
  ? path.resolve(process.argv[rootArgument + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const evidenceRoot = path.join(root, "release", "evidence");
const installerName = `CC-Fix-Setup-${packageJson.version}-x64.exe`;
const installerPath = path.join(root, "release", "installer", installerName);
const checksumPath = path.join(evidenceRoot, `${installerName}.sha256`);
const buildInfoPath = path.join(evidenceRoot, "build-info.json");
const sbomPath = path.join(evidenceRoot, "sbom.cdx.json");

async function readOrFail(filePath, label) {
  try {
    return await readFile(filePath);
  } catch (error) {
    throw new Error(`${label} unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const [installer, buildInfoRaw, checksumRaw, sbomRaw] = await Promise.all([
  readOrFail(installerPath, "installer"),
  readOrFail(buildInfoPath, "build-info"),
  readOrFail(checksumPath, "checksum file"),
  readOrFail(sbomPath, "SBOM"),
]);

const actual = createHash("sha256").update(installer).digest("hex");
const buildInfo = JSON.parse(buildInfoRaw.toString("utf8"));
const checksum = checksumRaw.toString("utf8").trim();
const sbom = JSON.parse(sbomRaw.toString("utf8"));

const failures = [];
if (buildInfo.version !== packageJson.version) failures.push("build-info version mismatch");
if (buildInfo.installer?.sha256 !== actual) failures.push("build-info installer digest mismatch");
if (checksum !== `${actual}  ${installerName}`) failures.push("checksum file mismatch");
if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5" || !Array.isArray(sbom.components) || sbom.components.length === 0) failures.push("invalid or empty CycloneDX SBOM");
if (failures.length > 0) {
  console.error(`Release evidence validation failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else console.log(`Release evidence verified: ${installerName}`);
