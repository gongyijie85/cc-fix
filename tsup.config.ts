import { defineConfig } from "tsup";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// #94：noExternal 收窄到运行时第三方依赖（本包 devDeps 仅为编译期/发布工具，
// 运行时唯一第三方 imports 为 chalk/commander/cli-table3），不再全量打包。
// banner 的 shebang 只对执行入口有意义：tsup 会把它写入全部产出（含共享 chunk），
// 此处 onSuccess 把 dist/chunk-*.js 首行 shebang 剥掉，避免被当作脚本执行面。
async function stripChunkShebangs() {
  const files = await readdir("dist").catch(() => []);
  await Promise.all(
    files
      .filter((name) => name.startsWith("chunk-") && name.endsWith(".js"))
      .map(async (name) => {
        const path = join("dist", name);
        const source = await readFile(path, "utf8");
        if (!source.startsWith("#!")) return;
        const firstEol = source.indexOf("\n");
        const rest = firstEol === -1 ? "" : source.slice(firstEol + 1);
        await writeFile(path, rest, "utf8");
      }),
  );
}

export default defineConfig({
  // entry 用对象形式把 sidecar 输出到 dist 根（dist/sidecar.js，而非 dist/gui/）：
  // 桌面壳以 core/sidecar.js 启动且 sidecar 内以 ../native 解析 helper，扁平部署三处契约才一致。
  entry: { index: "src/index.ts", sidecar: "src/gui/sidecar.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: true,
  // 与 package.json engines >=20 对齐：npm 渠道承诺 Node 20+，语法按 Node 20 下沉。
  target: "node20",
  noExternal: [/^(chalk|commander|cli-table3)$/],
  loader: {
    ".html": "text",
  },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  onSuccess: stripChunkShebangs,
});
