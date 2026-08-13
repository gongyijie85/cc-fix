import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/gui/sidecar.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: "node20",
  noExternal: [/.*/],
  loader: {
    ".html": "text",
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
