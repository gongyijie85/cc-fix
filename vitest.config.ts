import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // 并行度折中：自动（31 workers）实测 durable-file/recovery-executor 约 1/2 概率抖动
    // （真实 FS 写校验在高并发下超时）；2 workers 稳定但慢 2.7×。8 为实测稳定的上限。
    maxWorkers: 8,
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
