import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/gui/sidecar.ts"],
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
