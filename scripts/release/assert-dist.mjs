// prepack 守卫（#97）：npm pack/publish 前确认核心 bundle 存在。
// 从未构建的 git checkout 直接发布会带空 dist（files 白名单含 dist），
// 此处 fail-fast 替代“空包发布后才发现”。
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const required = ["dist/index.js", "dist/sidecar.js"];

for (const relative of required) {
  const absolute = path.join(repoRoot, relative);
  try {
    const info = await stat(absolute);
    if (!info.isFile() || info.size === 0) {
      console.error(`[assert-dist] ${relative} 为空文件；请先运行 pnpm build`);
      process.exit(1);
    }
  } catch {
    console.error(`[assert-dist] 缺少 ${relative}；请先运行 pnpm build`);
    process.exit(1);
  }
}
console.log("[assert-dist] dist 入口齐备");
