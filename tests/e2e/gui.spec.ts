// GUI E2E（T18）：首载/刷新/全模式/非 US 转换/恢复页 + a11y 冒烟。
// 只读断言，绝不点击会写系统设置的按钮（按钮存在性/可访问名/键盘可达性即可）。
import { test, expect, type Page } from "@playwright/test";
import {
  startGuiHarness,
  dailyState,
  standardState,
  deepJapanState,
  recoveryRequiredState,
  type GuiHarness,
} from "./gui-fixtures.js";

let harness: GuiHarness;

async function openApp(page: Page, fixture?: { state?: unknown }): Promise<void> {
  harness = await startGuiHarness(fixture);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(harness.baseUrl, { waitUntil: "domcontentloaded" });
  // 等待页面完成初始 API 加载（status/history/regions/fonts）
  await expect(page.locator("#statusText")).not.toHaveText("检测中...", { timeout: 15_000 });
  (page as Page & { __errors?: string[] }).__errors = errors;
}

test.afterEach(async () => {
  await harness?.stop();
});

test("首载：渲染状态栏与操作控件，无控制台错误", async ({ page }) => {
  await openApp(page, { state: dailyState() });
  await expect(page).toHaveTitle("CC-Fix 环境安全检测");
  await expect(page.locator("#statusText")).toBeVisible();
  await expect(page.locator("#btnOn")).toBeVisible();
  await expect(page.locator("#btnOff")).toBeVisible();
  await expect(page.locator("#btnRefresh")).toBeVisible();
  const errors = (page as Page & { __errors?: string[] }).__errors ?? [];
  expect(errors).toEqual([]);
});

test("刷新后会话保持：仍为认证状态", async ({ page }) => {
  await openApp(page, { state: dailyState() });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#statusText")).not.toHaveText("检测中...", { timeout: 15_000 });
  // 未授权会返回 401 → 状态栏停留在"检测中"或出现错误；这里断言 API 仍可用
  const statusResponse = await page.evaluate(async () => {
    const res = await fetch("/api/status");
    return { ok: res.ok, status: res.status };
  });
  expect(statusResponse.ok).toBe(true);
});

test("全模式：daily/standard/deep 状态栏与控件正确", async ({ page }) => {
  await openApp(page, { state: dailyState() });
  await expect(page.locator("#statusText")).toContainText("daily", { timeout: 15_000 });
  await harness.stop();

  harness = await startGuiHarness({ state: standardState() });
  await page.goto(harness.baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#statusText")).toContainText("standard", { timeout: 15_000 });
  await expect(page.locator("#levelSelect")).toHaveValue("standard");

  await harness.stop();
  harness = await startGuiHarness({ state: deepJapanState() });
  await page.goto(harness.baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#statusText")).toContainText("deep", { timeout: 15_000 });
  await expect(page.locator("#levelSelect")).toHaveValue("deep");
});

test("非 US 转换基线：deep/jp 状态下地区选择器为 jp", async ({ page }) => {
  await openApp(page, { state: deepJapanState() });
  await expect(page.locator("#statusText")).toContainText("deep", { timeout: 15_000 });
  await expect(page.locator("#regionSelect")).toHaveValue("jp");
  await expect(page.locator("#levelSelect")).toHaveValue("deep");
});

test("恢复页：recovery_required 时显示恢复入口与提示", async ({ page }) => {
  await openApp(page, { state: recoveryRequiredState() });
  await expect(page.locator("#statusText")).toContainText("recovery_required", { timeout: 15_000 });
  await expect(page.locator("#btnRecover")).toBeVisible();
  await expect(page.locator("#regionHint")).toBeVisible();
});

test("a11y 冒烟：状态播报区域、按钮可访问名、键盘可达性", async ({ page }) => {
  await openApp(page, { state: dailyState() });
  // 状态播报：role=status + aria-live
  const statusBar = page.locator('[role="status"]');
  await expect(statusBar.first()).toBeVisible();
  // 可访问名：按钮按名称可寻址
  await expect(page.getByRole("button", { name: /一键切换到安全环境/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /一键还原日常配置/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /重新检测/ })).toBeVisible();
  // 选择器带可访问名
  await expect(page.getByRole("combobox", { name: "目标地区" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "保护强度" })).toBeVisible();
  // 键盘可达：Tab 聚焦操作按钮（不激活，避免写系统设置）
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.id ?? null);
  expect(["btnOn", "btnOff", "btnRefresh", "regionSelect", "levelSelect"]).toContain(focused);
});
