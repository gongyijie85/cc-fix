import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import vitestConfig from "../vitest.config.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
) as { scripts: Record<string, string> };


const implementedStages = [
  "test:integration",
  "test:gui",
  "build:core",
  "build:desktop",
  "build:installer",
  "verify:payload",
  "test:windows",
  "release:bundle",
] as const;


describe("verification command contract", () => {
  it("keeps existing commands and provides a real coverage command", () => {
    expect(packageJson.scripts.typecheck).toBeDefined();
    expect(packageJson.scripts.test).toBeDefined();
    expect(packageJson.scripts.build).toBeDefined();
    expect(packageJson.scripts["test:coverage"]).toBe("node scripts/run-coverage.mjs");
  });


  it.each(implementedStages)("routes implemented stage %s to a real command", (stage) => {
    expect(packageJson.scripts[stage]).toBeDefined();
    expect(packageJson.scripts[stage]).not.toContain("not-implemented-stage.mjs");
  });
});

describe("coverage contract", () => {
  it("uses the approved global and future critical-module thresholds", () => {
    const coverage = vitestConfig.test?.coverage;

    expect(coverage?.thresholds).toMatchObject({
      lines: 80,
      statements: 80,
      functions: 80,
      branches: 75,
      "src/domain/**": { branches: 90 },
      "src/state/**": { branches: 90 },
      "src/persist/**": { branches: 90 },
    });
  });

  it("writes coverage to the deterministic ignored test-results directory", async () => {
    expect(vitestConfig.test?.coverage?.include).toEqual(["src/**/*.ts"]);
    expect(vitestConfig.test?.coverage?.exclude).toEqual(["src/**/*.test.ts"]);
    expect(vitestConfig.test?.coverage?.reportsDirectory).toBe(".test-results/coverage");

    const gitignore = await readFile(path.join(repositoryRoot, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\.test-results\/$/m);
    expect(gitignore).toMatch(/^\.wayfinder\/temp\/$/m);
    expect(gitignore).toMatch(/^\.wayfinder\/worktrees\/$/m);
    expect(gitignore).toMatch(/^\.worktrees\/$/m);
  });
});
