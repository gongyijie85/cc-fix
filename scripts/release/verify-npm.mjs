// npm 发布前本地验证（T29）：pack → 内容白名单 → 安装 smoke。
// 在真实 npm publish 之前验证 tarball 只含声明产物、版本一致、安装后可运行。
// 支持 --root <dir>（指向含 package.json 的包根）供 fixture 测试。
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootArgument = process.argv.indexOf("--root");
const root = rootArgument >= 0
  ? path.resolve(process.argv[rootArgument + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const failures = [];

// 1) 内容白名单：files 字段必须含 dist（构建产物）；空 files 会发布整个仓库，直接阻断。
const allowedTopLevel = new Set(packageJson.files ?? []);
if (!allowedTopLevel.has("dist")) failures.push("npm files must include dist (built bundle)");
if (allowedTopLevel.size === 0) failures.push("npm files list is empty; publish would ship everything");

// 2) pack 到临时目录（dry-run 不产生可安装产物，这里用真 pack）。
// 临时目录放在仓库内（.wayfinder/temp，路径无空格）：cmd.exe 包装的命令行引号处理不可靠。
await mkdir(path.join(root, ".wayfinder", "temp"), { recursive: true });
const packRoot = await mkdtemp(path.join(root, ".wayfinder", "temp", "npm-verify-"));
const packResult = spawnSync(
  process.platform === "win32" ? "cmd.exe" : "pnpm",
  process.platform === "win32"
    ? ["/d", "/s", "/c", "pnpm pack --pack-destination " + packRoot]
    : ["pack", "--pack-destination", packRoot],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const packOutput = (packResult.stdout ?? "") + (packResult.stderr ?? "");
let tarballName;
try {
  tarballName = (await readdir(packRoot)).find((name) => name.endsWith(".tgz"));
} catch {
  tarballName = undefined;
}
if (packResult.status !== 0 || tarballName === undefined) {
  failures.push("npm pack failed: " + packOutput.slice(0, 500));
} else {
  const tarball = path.join(packRoot, tarballName);
  // 3) 安装到隔离目录并做 CLI smoke。
  const installRoot = path.join(packRoot, "install");
  await mkdir(installRoot, { recursive: true });
  const install = spawnSync(
    process.platform === "win32" ? "cmd.exe" : "npm",
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npm install --prefix " + installRoot + " " + tarball + " --no-audit --no-fund"]
      : ["install", "--prefix", installRoot, tarball, "--no-audit", "--no-fund"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (install.status !== 0) {
    failures.push("npm install of tarball failed: " + (install.stderr ?? "").slice(0, 500));
  } else {
    // 4) CLI smoke：安装后的 bin 必须能输出 --version 且与包版本一致。
    const binPath = process.platform === "win32"
      ? path.join(installRoot, "node_modules", ".bin", "cc-fix.cmd")
      : path.join(installRoot, "node_modules", ".bin", "cc-fix");
    // Windows 下 .cmd 不能直接 spawnSync，需经 cmd.exe 包装（与 scripts/ci 门禁同因）。
    const version = process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", binPath + " --version"], { encoding: "utf8", timeout: 30_000 })
      : spawnSync(binPath, ["--version"], { encoding: "utf8", timeout: 30_000 });
    const versionText = (version.stdout ?? "").trim();
    if (version.status !== 0) {
      failures.push("installed CLI --version failed: " + (version.stderr ?? "").slice(0, 300));
    } else if (versionText !== packageJson.version) {
      failures.push("installed CLI version " + versionText + " != package version " + packageJson.version);
    }
    // 5) 泄漏抽查：安装产物里不得出现未在 files 白名单中的顶层路径。
    const installedPkg = JSON.parse(await readFile(path.join(installRoot, "node_modules", "cc-fix", "package.json"), "utf8"));
    const installedAllowed = new Set(installedPkg.files ?? []);
    for (const candidate of ["release", "tests", "tasks", "docs", "src", ".wayfinder"]) {
      if (installedAllowed.has(candidate)) continue;
      try {
        await stat(path.join(installRoot, "node_modules", "cc-fix", candidate));
        failures.push("tarball leaks unexpected top-level path: " + candidate);
      } catch {
        // expected absence
      }
    }
  }
}

await rm(packRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.error("CC_FIX_NPM_FAIL: " + failures.length + " issue(s)\n- " + failures.join("\n- "));
  process.exitCode = 1;
} else {
  console.log("CC_FIX_NPM_OK: tarball " + (tarballName ?? "(unknown)") + " packed, installed and version-verified (" + packageJson.version + ")");
}
