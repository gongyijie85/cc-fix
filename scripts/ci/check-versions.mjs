// CI 门禁：版本一致性检查（T27）。委托给 check-version-consistency.mjs 并透传结果。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootArgument = process.argv.indexOf("--root");
const repositoryRoot = rootArgument >= 0
  ? path.resolve(process.argv[rootArgument + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const script = path.join(repositoryRoot, "scripts", "check-version-consistency.mjs");
const result = spawnSync(process.execPath, [script, ...(rootArgument >= 0 ? ["--root", repositoryRoot] : [])], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status !== 0) {
  console.error("CC_FIX_VERSIONS_FAIL: version consistency gate failed");
  process.exitCode = result.status ?? 1;
} else {
  console.log("CC_FIX_VERSIONS_OK");
}
