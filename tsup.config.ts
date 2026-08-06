import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: "node20",
  loader: {
    ".html": "text",
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
