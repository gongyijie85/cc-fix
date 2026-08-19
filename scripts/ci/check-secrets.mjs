// CI 门禁：仓库密钥扫描（T27）。fail-closed——命中已知凭据形态即失败。
// 默认扫描仓库根；--root <dir> 供测试注入临时目录。
// --allow 只接受 allowlist 文件中登记的别名（issue #56）：别名与放行子串一一对应、
// 随仓库评审，CI 调用行被篡改也无法放行任意子串。默认 allowlist 为同目录
// secrets-allowlist.txt，测试可用 --allowlist <file> 注入。
// 读取失败、损坏符号链接、未知别名、损坏白名单一律判失败——不留 fail-open 面。
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const repositoryRoot = argumentValue("--root")
  ? path.resolve(argumentValue("--root"))
  : path.resolve(scriptDirectory, "..", "..");
const allowlistPath = argumentValue("--allowlist")
  ? path.resolve(argumentValue("--allowlist"))
  : path.resolve(scriptDirectory, "secrets-allowlist.txt");
const allowArgument = argumentValue("--allow");

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
  // issue #56：值不再要求引号包裹（API_KEY=xxx），字符集补 . / +，阈值 24→16；
  // 键后允许闭引号以覆盖 JSON 形态（"api_key": "value"）。
  { id: "generic-assignment", pattern: /\b(?:api[_-]?key|secret|token|password)\b["']?\s*[:=]\s*["']?[0-9A-Za-z_\-./+]{16,}["']?/iu },
];

const findings = [];
const configurationProblems = [];
let scannedFiles = 0;

function relativePath(filePath) {
  return path.relative(repositoryRoot, filePath) || path.basename(filePath);
}

/** allowlist 行格式 `别名=子串`；# 注释。损坏行报配置问题（fail-closed）。 */
async function loadAllowlist() {
  let text;
  try {
    text = await readFile(allowlistPath, "utf8");
  } catch {
    if (allowArgument !== undefined) {
      configurationProblems.push(`allowlist unavailable while --allow was passed: ${allowlistPath}`);
    }
    return new Map();
  }
  const entries = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      configurationProblems.push(`malformed allowlist line: ${trimmed}`);
      continue;
    }
    entries.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }
  return entries;
}

const allowedSubstrings = new Set();
if (allowArgument !== undefined) {
  const allowlist = await loadAllowlist();
  for (const alias of allowArgument.split(",").map((value) => value.trim()).filter(Boolean)) {
    const value = allowlist.get(alias);
    if (value === undefined) {
      configurationProblems.push(`unknown allow alias: ${alias} (register it in ${path.relative(repositoryRoot, allowlistPath) || allowlistPath})`);
    } else {
      allowedSubstrings.add(value);
    }
  }
} else {
  await loadAllowlist(); // 仍然解析：损坏白名单即使未使用也立即暴露
}

async function scanFile(filePath) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    // issue #56：不可读文件不再静默跳过——无法扫描即视为失败。
    findings.push({ file: relativePath(filePath), line: 0, id: "unreadable", preview: String(error?.code ?? "read-failed") });
    return;
  }
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const candidate of SECRET_PATTERNS) {
      const match = line.match(candidate.pattern);
      if (match === null) continue;
      const matched = match[0];
      if ([...allowedSubstrings].some((item) => matched.includes(item))) continue;
      findings.push({
        file: relativePath(filePath),
        line: index + 1,
        id: candidate.id,
        preview: matched.length > 24 ? matched.slice(0, 24) + "…" : matched,
      });
      break; // 每行只报第一个命中
    }
  }
}

const visitedDirectories = new Set();
let repositoryRealRoot = repositoryRoot;

async function walk(directory) {
  const real = await realpath(directory);
  if (visitedDirectories.has(real)) return;
  visitedDirectories.add(real);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await walk(full);
      continue;
    }
    // issue #56：符号链接不再静默跳过——经链接引入的文件/目录同样要扫。
    if (entry.isSymbolicLink()) {
      let target;
      try {
        target = await stat(full);
      } catch {
        findings.push({ file: relativePath(full), line: 0, id: "unreadable", preview: "broken-symlink" });
        continue;
      }
      if (target.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        // 只递归指向仓库内部的目录链接：外部目录（网络盘/系统目录）不可无界遍历。
        const targetReal = await realpath(full);
        if (targetReal !== repositoryRealRoot && !targetReal.startsWith(repositoryRealRoot + path.sep)) continue;
        await walk(full);
        continue;
      }
      if (!target.isFile()) continue;
    } else if (!entry.isFile()) {
      continue;
    }
    // 白名单文件本身是经过评审的登记表，天然包含密钥形态的子串——不作为扫描对象。
    if (path.resolve(full) === allowlistPath) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (SKIPPED_EXTENSIONS.has(extension)) continue;
    scannedFiles += 1;
    await scanFile(full);
  }
}

repositoryRealRoot = await realpath(repositoryRoot);
await walk(repositoryRoot);

const problems = [...configurationProblems, ...findings];
if (problems.length > 0) {
  console.error(`CC_FIX_SECRETS_FAIL: ${problems.length} problem(s) in ${scannedFiles} scanned files`);
  for (const problem of configurationProblems) {
    console.error(`  [configuration] ${problem}`);
  }
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} [${finding.id}] ${finding.preview}`);
  }
  process.exitCode = 1;
} else {
  console.log(`CC_FIX_SECRETS_OK: no known credential patterns in ${scannedFiles} scanned files`);
}
