// 发布前剥离 dist 内 sourcemap（#84 决议：#85 实施）
// npm files 白名单不支持子路径排除，sourcemap 对发布包是死重（-33% tarball 体积）；
// 构建仍保留 sourcemap: true（本地 dist 调试），prepack 时删除，下次 build 自动恢复。
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");

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
