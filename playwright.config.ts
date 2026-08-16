// Playwright E2E 配置（T18）：GUI 页面级测试，验证真实 bundle + 认证会话 + 渲染/a11y。
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:1", // 由 fixture 注入真实 URL；此处仅占位
    headless: true,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
