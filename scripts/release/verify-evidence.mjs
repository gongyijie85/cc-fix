import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const evidenceRoot = path.join(root, "release", "evidence");
const installerName = `CC-Fix-Setup-${packageJson.version}-x64.exe`;
const installer = await readFile(path.join(root, "release", "installer", installerName));
const actual = createHash("sha256").update(installer).digest("hex");
const buildInfo = JSON.parse(await readFile(path.join(evidenceRoot, "build-info.json"), "utf8"));
const checksum = (await readFile(path.join(evidenceRoot, `${installerName}.sha256`), "utf8")).trim();
const sbom = JSON.parse(await readFile(path.join(evidenceRoot, "sbom.cdx.json"), "utf8"));
const failures = [];
if (buildInfo.version !== packageJson.version) failures.push("build-info version mismatch");
if (buildInfo.installer?.sha256 !== actual) failures.push("build-info installer digest mismatch");
if (checksum !== `${actual}  ${installerName}`) failures.push("checksum file mismatch");
if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5" || !Array.isArray(sbom.components) || sbom.components.length === 0) failures.push("invalid or empty CycloneDX SBOM");
if (failures.length > 0) {
  console.error(`Release evidence validation failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else console.log(`Release evidence verified: ${installerName}`);
