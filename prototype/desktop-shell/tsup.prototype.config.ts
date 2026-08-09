import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/gui/desktop-server.prototype.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  splitting: false,
  sourcemap: false,
  minify: false,
  clean: true,
  outDir: "prototype/desktop-shell/build/app",
  outExtension: () => ({ js: ".mjs" }),
  noExternal: [/.*/],
  loader: { ".html": "text" },
});
