import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = await readFile(path.join(root, "README.md"), "utf8");
const spec = await readFile(path.join(root, "SPEC.md"), "utf8");
const installer = await readFile(path.join(root, "scripts", "install.ps1"), "utf8");
const failures = [];
for (const token of ["daily", "standard", "deep", "persist recover", "us", "eu", "jp", "sg", "WebView2", "Node.js 24"]) {
  if (!readme.includes(token)) failures.push(`README is missing ${token}`);
}
for (const forbidden of ["本工具不修改系统设置", "Windows 原生应用不受影响", "其余语言/区域设置不动系统项", "cc-fix persist --region"]) {
  if (`${readme}\n${spec}`.includes(forbidden)) failures.push(`retired behavior claim remains: ${forbidden}`);
}
if (!/VPN.*DNS.*不修改/s.test(readme) || !/VPN.*DNS.*never modify/s.test(spec)) failures.push("network reminder-only boundary is missing");
if (!installer.includes("LegacyNpmCli") || !installer.includes("does not install the desktop product")) failures.push("legacy installer does not fail closed as an explicit compatibility channel");
if (failures.length > 0) {
  console.error(`Documentation consistency check failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else console.log("Documentation consistency check passed");
