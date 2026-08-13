import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    maxWorkers: 2,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "json", "html"],
      reportsDirectory: ".test-results/coverage",
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
        "src/domain/**": { branches: 90 },
        "src/state/**": { branches: 90 },
        "src/persist/**": { branches: 90 },
      },
    },
  },
});
