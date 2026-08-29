import { defineConfig } from "tsup";

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
  noExternal: [/.*/],
  loader: {
    ".html": "text",
  },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
