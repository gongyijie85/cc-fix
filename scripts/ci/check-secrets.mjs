// CI 门禁：仓库密钥扫描（T27）。fail-closed——命中已知凭据形态即失败。
// 默认扫描仓库根；--root <dir> 供测试注入临时目录；--allow <substring,...> 追加白名单子串。
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootArgument = process.argv.indexOf("--root");
const repositoryRoot = rootArgument >= 0
  ? path.resolve(process.argv[rootArgument + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const allowArgument = process.argv.indexOf("--allow");
const allowed = new Set(
  allowArgument >= 0 ? process.argv[allowArgument + 1].split(",").map((value) => value.trim()).filter(Boolean) : [],
);

const SKIPPED_DIRECTORIES = new Set([
  "node_modules", ".git", ".wayfinder", ".worktrees", "dist", "release",
  ".test-results", "target", ".cache", "coverage", ".pnpm-store",
]);
const SKIPPED_EXTENSIONS = new Set([
  ".exe", ".dll", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2",
  ".ttf", ".eot", ".pdb", ".zip", ".7z", ".msi", ".map", ".crate", ".svg",
]);

const SECRET_PATTERNS = [
  { id: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/u },
  { id: "github-token", pattern: /\bgh[pousr]_[0-9A-Za-z]{20,}\b/u },
  { id: "github-pat", pattern: /\bgithub_pat_[0-9A-Za-z_]{22,}\b/u },
  { id: "openai-key", pattern: /\bsk-[0-9A-Za-z]{20,}\b/u },
  { id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { id: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/u },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { id: "generic-assignment", pattern: /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][0-9A-Za-z_\-]{24,}["']/iu },
];

const findings = [];
let scannedFiles = 0;

async function scanFile(filePath) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return; // 二进制/不可读文件跳过
  }
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const candidate of SECRET_PATTERNS) {
      const match = line.match(candidate.pattern);
      if (match === null) continue;
      const matched = match[0];
      if ([...allowed].some((item) => matched.includes(item))) continue;
      findings.push({
        file: path.relative(repositoryRoot, filePath) || path.basename(filePath),
        line: index + 1,
        id: candidate.id,
        preview: matched.length > 24 ? matched.slice(0, 24) + "…" : matched,
      });
      break; // 每行只报第一个命中
    }
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (SKIPPED_EXTENSIONS.has(extension)) continue;
    scannedFiles += 1;
    await scanFile(full);
  }
}

await walk(repositoryRoot);

if (findings.length > 0) {
  console.error(`CC_FIX_SECRETS_FAIL: ${findings.length} potential secret(s) in ${scannedFiles} scanned files`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} [${finding.id}] ${finding.preview}`);
  }
  process.exitCode = 1;
} else {
  console.log(`CC_FIX_SECRETS_OK: no known credential patterns in ${scannedFiles} scanned files`);
}
