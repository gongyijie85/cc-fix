// GUI E2E（T18）：首载/刷新/全模式/非 US 转换/恢复页 + a11y 冒烟。
// 只读断言，绝不点击会写系统设置的按钮（按钮存在性/可访问名/键盘可达性即可）。
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
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
  await expect(page.locator("#btnOn")).toBeEnabled();
  (page as Page & { __errors?: string[] }).__errors = errors;
}

test.afterEach(async () => {
  await harness?.stop();
});

test('具体时区：沿用已提交洛杉矶，刷新保留选择，换日本后使用东京', async ({ page }) => {
  await openApp(page, { state: standardState('America/Los_Angeles') });
  const timezone = page.getByRole('combobox', { name: '具体时区' });
  await expect(timezone).toHaveValue('America/Los_Angeles');
  await timezone.selectOption('America/Chicago');
  await page.locator('#btnRefresh').click();
  await expect(timezone).toHaveValue('America/Chicago');
  await page.getByRole('combobox', { name: '目标地区' }).selectOption('jp');
  await expect(timezone).toHaveValue('Asia/Tokyo');
  await expect(timezone.locator('option')).toHaveCount(1);
});

test('具体时区：保护请求携带选中的城市（拦截写入）', async ({ page }) => {
  await openApp(page, { state: standardState('America/Los_Angeles') });
  await page.getByRole('combobox', { name: '具体时区' }).selectOption('America/Chicago');
  const request = page.waitForRequest('**/api/fix/on?**');
  await page.route('**/api/fix/on?**', (route) => route.fulfill({ status: 202, body: '' }));
  await page.locator('#btnOn').click();
  const url = new URL((await request).url());
  expect(url.searchParams.get('timezone')).toBe('America/Chicago');
  expect(url.searchParams.get('region')).toBe('us');
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

test("保护准备失败时显示服务端原因并允许重试", async ({ page }) => {
  // 保留真实检测事件流，通过同一监听器回放保护结果，避免测试写入系统设置。
  await page.addInitScript(() => {
    window.EventSource = class extends EventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        window.addEventListener("test-persist-event", (event) => {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify((event as CustomEvent).detail) }));
        });
      }
    };
  });
  await openApp(page, { state: standardState() });
  await page.evaluate(() => {
    for (const detail of [
      { type: "step-start", stepId: "persist", name: "上一次保护" },
      { type: "step-ok", stepId: "persist" },
      { type: "summary", ok: 1, fail: 0, rolledBack: false },
    ]) window.dispatchEvent(new CustomEvent("test-persist-event", { detail }));
  });
  await expect(page.locator("#step-persist .badge-ok")).toBeVisible();
  const message = "无法读取保护状态文件";
  await page.route("**/api/fix/on?**", (route) => route.fulfill({
    status: 500, json: { error: { id: "PERSIST_PREPARE_FAILED", code: 500, message } },
  }));
  const protect = page.locator("#btnOn");
  await protect.click();
  await expect(page.locator("#toast")).toHaveText(message);
  await page.evaluate((error) => {
    for (const detail of [
      { type: "step-start", stepId: "persist-prepare", name: "准备保护操作" },
      { type: "step-fail", stepId: "persist-prepare", error },
      { type: "summary", ok: 0, fail: 1, rolledBack: false, fatal: false, failedDuring: "prepare" },
    ]) window.dispatchEvent(new CustomEvent("test-persist-event", { detail }));
  }, message);
  await expect(page.locator("#fixTitle")).toHaveText("保护未启动");
  await expect(page.locator("#step-persist-prepare .err-box")).toHaveText(message);
  await expect(page.locator("#step-persist")).toHaveCount(0);
  await expect(page.locator("#fatalCta")).toBeHidden();
  await expect(protect).toBeEnabled();
});

test("离线字体契约：字体就绪且只从本地认证服务加载", async ({ page }) => {
  const fontRequests: string[] = [];
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "font") fontRequests.push(request.url());
    if (/^https?:\/\/(?!127\.0\.0\.1)/.test(request.url())) externalRequests.push(request.url());
  });
  await openApp(page, { state: dailyState() });
  const fontState = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      loaded: document.fonts.check('14px "CCFix Noto Sans SC"', "中文字体还原失败"),
      preload: document.querySelector('link[rel="preload"][as="font"]')?.getAttribute("href"),
    };
  });
  expect(fontState.loaded).toBe(true);
  expect(fontState.preload).toBe("/assets/fonts/cc-fix-noto-sans-sc.woff2");
  expect(fontRequests.some((url) => url.endsWith("/assets/fonts/cc-fix-noto-sans-sc.woff2"))).toBe(true);
  expect(externalRequests).toEqual([]);
});

test("响应式门禁：关键视口与 200% 缩放不产生意外横向溢出", async ({ page }) => {
  await openApp(page, { state: dailyState() });
  for (const viewport of [{ width: 375, height: 667 }, { width: 840, height: 620 }, { width: 1120, height: 760 }, { width: 1600, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#statusText")).not.toHaveText("检测中...", { timeout: 15_000 });
    const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(overflow.width, `${viewport.width}px viewport overflow`).toBeLessThanOrEqual(overflow.viewport);
  }
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  const zoomOverflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(zoomOverflow.width, "200% zoom overflow").toBeLessThanOrEqual(zoomOverflow.viewport);
});

test("a11y 门禁：交互元素都有名称且图标 SVG 不进入可访问树", async ({ page }) => {
  await openApp(page, { state: dailyState() });
  const audit = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("button, select, summary")];
    return {
      unnamed: controls.filter((element) => !(element.getAttribute("aria-label") || element.textContent?.trim())).map((element) => element.outerHTML.slice(0, 120)),
      visibleSvgWithoutHidden: [...document.querySelectorAll("svg")].filter((element) => element.getAttribute("aria-hidden") !== "true").length,
    };
  });
  expect(audit.unnamed).toEqual([]);
  expect(audit.visibleSvgWithoutHidden).toBe(0);
});

test("axe 门禁：页面无 serious/critical 可访问性问题", async ({ page }) => {
  await openApp(page, { state: dailyState() });
  await expect(page.locator("#btnOn")).toHaveCSS("opacity", "1");
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(blocking, blocking.map((violation) => `${violation.id}: ${violation.help}`).join("\n")).toEqual([]);
});

test("视觉基线：窄屏与桌面首屏层级稳定", { tag: "@visual-baseline" }, async ({ page }) => {
  test.skip(process.env.CI !== undefined, "截图使用本地参考环境的字体渲染基线");
  // 视觉基线只比较界面：真实出口、本机语言与检测中卡片会改变全文高度，不能成为基线输入。
  const response = {
    score: 0, riskLevel: 'low', status: 'supported', region: 'auto', matchedRegion: null,
    signals: [{ id: 'timezone', label: '系统时区', value: 'America/Los_Angeles', score: 0, weight: 25, contribution: 0, source: 'system', risk: 'low' }],
    ipIntelligence: null, recommendations: [],
  };
  await page.route('**/api/check/start', (route) => route.fulfill({ status: 202, body: '' }));
  await page.route('**/api/events', (route) => route.fulfill({
    contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'detect-done', response })}\n\n`,
  }));
  await page.route('**/api/fonts/status', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ found: [], missing: [], backedUp: false, pendingReboot: [] }),
  }));
  await openApp(page, { state: standardState('America/Los_Angeles') });
  for (const [name, width, height] of [["narrow", 375, 667], ["desktop", 840, 620]] as const) {
    await page.setViewportSize({ width, height });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#statusText")).not.toHaveText("检测中...", { timeout: 15_000 });
    await expect(page.locator('#timezoneSelect')).toBeEnabled();
    await expect(page.locator('#detectCard')).not.toHaveClass(/visible/);
    await expect(page).toHaveScreenshot(`gui-${name}.png`, {
      fullPage: true,
      animations: "disabled",
      // 跨 Chromium 构建抗锯齿差异：允许 ≤1% 像素抖动，防版本漂移误报；真实布局回归仍会远超此限
      maxDiffPixelRatio: 0.01,
    });
  }
});

test("字体资产阻断时回退渲染不崩溃且核心界面可操作（#63）", async ({ page }) => {
  await page.route("**/assets/fonts/*.woff2", (route) => route.abort());
  await openApp(page, { state: dailyState() });
  await expect(page.locator("#statusText")).not.toHaveText("检测中...", { timeout: 15_000 });
  const fontState = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      loaded: document.fonts.check('14px "CCFix Noto Sans SC"', "还原失败"),
      statusVisible: Boolean(document.getElementById("statusText")?.textContent?.trim()),
    };
  });
  expect(fontState.loaded).toBe(false);
  expect(fontState.statusVisible).toBe(true);
  await expect(page.locator("#btnRefresh")).toBeEnabled();
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
test("选择地区后在重新检测中保留（#89）：用户选择不被 loadStatus 覆盖", async ({ page }) => {
  await openApp(page, { state: dailyState() });
  // 等待首次 detect-done 全量构建出地区选择器
  await expect(page.locator("#regionSelect")).toBeVisible({ timeout: 15_000 });
  // 用户手动选择 jp，change 监听记录 userPickedRegion
  await page.locator("#regionSelect").selectOption("jp");
  await expect(page.locator("#regionSelect")).toHaveValue("jp");
  // 刷新 = content 全量重建 + 再次 loadStatus
  await page.locator("#btnRefresh").click();
  await expect(page.locator("#detectResult")).toBeVisible({ timeout: 15_000 });
  // 用户选择被保留（loadStatus 不再覆盖 userPickedRegion；renderFullContent 恢复 savedRegion）
  await expect(page.locator("#regionSelect")).toHaveValue("jp");
  const errors = (page as Page & { __errors?: string[] }).__errors ?? [];
  expect(errors).toEqual([]);
});

test("detect-done 局部补丁不再重拉 regions/status（#89）", async ({ page }) => {
  await openApp(page, { state: dailyState() });
  await expect(page.locator("#regionSelect")).toBeVisible({ timeout: 15_000 });

  const regionsStatusRequests: string[] = [];
  page.on("request", (request) => {
    const u = request.url();
    if (u.includes("/api/regions") || u.includes("/api/status")) regionsStatusRequests.push(u);
  });

  // 先记录本轮标题变化，快速检测可能在 Playwright 第一次轮询前就已经结束。
  const titles = await page.locator("#detectTitle").evaluateHandle((title) => {
    const seen: string[] = [];
    const observer = new MutationObserver((changes) => {
      for (const change of changes) {
        for (const node of change.addedNodes) seen.push(node.textContent ?? "");
      }
      if (seen.includes("检测完成")) observer.disconnect();
    });
    observer.observe(title, { childList: true });
    return seen;
  });
  const status = await page.evaluate(async () => (await fetch("/api/check/start", { method: "POST" })).status);
  expect(status).toBe(202);
  await expect.poll(() => titles.jsonValue(), { timeout: 15_000 }).toContain("检测完成");
  expect((await titles.jsonValue())[0]).toBe("检测进行中…");
  await expect(page.locator("#detectTitle")).toHaveText("检测完成", { timeout: 15_000 });

  // 补丁路径不应重新请求 regions/status（regions 已缓存，纯检测不改 status）
  expect(regionsStatusRequests).toEqual([]);
});
