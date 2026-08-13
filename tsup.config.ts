import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/gui/sidecar.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: "node24",
  noExternal: [/.*/],
  loader: {
    ".html": "text",
  },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
