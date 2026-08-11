import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const vitestEntry = resolve('node_modules/vitest/vitest.mjs');
const coverage = spawnSync(process.execPath, [vitestEntry, 'run', '--coverage'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
const critical = spawnSync(
  process.execPath,
  [resolve('scripts/check-critical-coverage.mjs')],
  { cwd: process.cwd(), stdio: 'inherit' },
);

if (coverage.error) process.stderr.write(`[coverage] vitest launch failed: ${coverage.error.message}\n`);
if (critical.error) process.stderr.write(`[coverage] critical checker launch failed: ${critical.error.message}\n`);
process.exitCode = coverage.status === 0 && critical.status === 0 ? 0 : 1;
