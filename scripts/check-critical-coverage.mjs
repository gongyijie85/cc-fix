import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CRITICAL_COVERAGE_GROUPS = ['domain', 'state', 'persist'];

export function aggregateCriticalBranches(coverage) {
  const totals = Object.fromEntries(
    CRITICAL_COVERAGE_GROUPS.map((group) => [group, { covered: 0, total: 0 }]),
  );
  for (const [rawPath, report] of Object.entries(coverage)) {
    const normalized = rawPath.replaceAll('\\', '/');
    const group = CRITICAL_COVERAGE_GROUPS.find((candidate) =>
      normalized.includes(`/src/${candidate}/`),
    );
    if (group === undefined || report === null || typeof report !== 'object') continue;
    const branches = report.b;
    if (branches === null || typeof branches !== 'object') continue;
    for (const counts of Object.values(branches)) {
      if (!Array.isArray(counts)) continue;
      totals[group].total += counts.length;
      totals[group].covered += counts.filter((count) => typeof count === 'number' && count > 0).length;
    }
  }
  return totals;
}

export async function checkCriticalCoverage(
  coveragePath = '.test-results/coverage/coverage-final.json',
  threshold = 90,
) {
  const coverage = JSON.parse(await readFile(resolve(coveragePath), 'utf8'));
  const totals = aggregateCriticalBranches(coverage);
  let passed = true;
  for (const group of CRITICAL_COVERAGE_GROUPS) {
    const { covered, total } = totals[group];
    if (total === 0) {
      process.stdout.write(`[critical-coverage] src/${group}: no instrumented branches\n`);
      continue;
    }
    const percentage = (covered / total) * 100;
    const groupPassed = percentage >= threshold;
    passed &&= groupPassed;
    process.stdout.write(
      `[critical-coverage] src/${group}: ${percentage.toFixed(2)}% (${covered}/${total}) ${groupPassed ? 'PASS' : `FAIL < ${threshold}%`}\n`,
    );
  }
  return passed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const passed = await checkCriticalCoverage(process.argv[2], Number(process.argv[3] ?? 90));
  process.exitCode = passed ? 0 : 1;
}
