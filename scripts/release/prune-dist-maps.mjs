// 发布前剥离 dist 内 sourcemap（#84 决议：#85 实施）
// npm files 白名单不支持子路径排除，sourcemap 对发布包是死重（-33% tarball 体积）；
// 构建仍保留 sourcemap: true（本地 dist 调试），prepack 时删除，下次 build 自动恢复。
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const distRoot = path.join(repoRoot, "dist");

async function collectMaps(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const maps = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) maps.push(...(await collectMaps(absolute)));
    else if (entry.name.endsWith(".map")) maps.push(absolute);
  }
  return maps;
}

const maps = await collectMaps(distRoot);
await Promise.all(maps.map((file) => rm(file, { force: true })));
console.log(`[prepack] pruned ${maps.length} sourcemap file(s) from dist`);

// #85 后续：npm 兼容渠道的 persist 生命周期（on→off 的验证后备份删除）依赖 Windows 原生 helper。
// 发布期 release:bundle 已用 cargo 构建 native-helper/target/release/；prepack 时把它随包放到
// native/，使 `dist/../native/` 解析命中（node_modules/cc-fix/native/）。无 cargo 产物（本地未构建）时跳过，
// 该渠道 persist off 会提示「Verified native backup deletion is unavailable」（已知限制）。
const helper = path.join(repoRoot, "native-helper", "target", "release", "cc-fix-native-helper.exe");
const nativeDir = path.join(repoRoot, "native");
try {
  await copyFile(helper, path.join(nativeDir, "cc-fix-native-helper.exe"));
  const digest = createHash("sha256").update(await readFile(helper)).digest("hex");
  await writeFile(path.join(nativeDir, "cc-fix-native-helper.exe.sha256"), digest, "utf8");
  console.log("[prepack] staged native helper into native/");
} catch {
  await mkdir(nativeDir, { recursive: true });
  console.log("[prepack] native helper not built; npm persist off will be unavailable");
}
