/**
 * Wire local git hooks only inside this repo's working tree.
 * Never touch the consumer's git config on `npm install -g cc-fix`.
 */
import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
  accessSync(join(root, ".git"), constants.F_OK);
} catch {
  process.exit(0);
}

const result = spawnSync(
  "git",
  ["config", "core.hooksPath", "scripts/hooks"],
  { cwd: root, stdio: "ignore", shell: process.platform === "win32" },
);

process.exit(result.status === 0 ? 0 : 0);
