# GitHub 同类项目与 GUI 优化调研（字体专项）

> 调研日期：2026-08-26  
> 范围：字体自托管/回退、UI 架构、设计系统、性能、可访问性、响应式、测试与工程质量。  
> 结论先行：CC-Fix 当前最大的产品风险不是“字体栈不够长”，而是应用会主动移除它正在回退依赖的系统中文字体。必须先让 GUI 使用随安装包分发的、许可证清晰的 CJK Web 字体；其次再做响应式、对比度与前端拆分。

## 1. 本项目基线

CC-Fix 是 Windows 10/11 x64 的环境检测与可恢复保护工具，桌面层为 Tauri 2 + WebView2，GUI 由本地认证 HTTP 服务提供；前端没有框架，是一个约 36 KB、708 行的内联 HTML/CSS/JS 文件。核心与持久化层已有 Vitest、Rust、Playwright 和 Windows 安装生命周期测试，工程基础明显强于同类脚本工具。

相关本地依据：

- [`README.md`](../../README.md) 与 [`package.json`](../../package.json)：Tauri/Node/TypeScript/Rust 技术栈和验证命令。
- [`src/gui/index.html`](../../src/gui/index.html)：单文件 GUI、系统字体回退、内联 CSS/JS。
- [`src/fonts/catalog.ts`](../../src/fonts/catalog.ts)：会移除 `msyh`、`simsun`、`dengxian` 等中文系统字体。
- [`docs/adr/0013-font-fix-flow.md`](../adr/0013-font-fix-flow.md)：字体移除是独立的破坏性流程。
- [`tests/e2e/gui.spec.ts`](../../tests/e2e/gui.spec.ts)：已有首载、状态、键盘可达和 ARIA 冒烟测试。

### 现状的具体问题

1. **字体存在闭环缺陷。** `body` 依次依赖 Segoe UI、微软雅黑、苹方、Noto/思源等“系统已安装字体”，仓库和安装包没有自有 CJK 字体资源；而字体修复流恰好会删除 Windows 默认中文字体。删除后 GUI 最需要解释“发生了什么、如何还原”时，反而可能出现方框或缺字。
2. **字体回退声明不等于字体可用。** CSS 中列出 `Noto Sans SC`、`Source Han Sans SC` 只会查找本机字体，并不会下载或打包它们。
3. **单文件已接近维护拐点。** 708 行中混合设计令牌、DOM 模板、API 调用、SSE 状态机和字体修复逻辑；继续增加功能会让视觉回归、无障碍和状态组合越来越难隔离测试。
4. **没有真正的响应式规则。** 页面只有 `max-width: 800px`，没有 `@media`；操作按钮不换行，表格没有窄屏降级。Tauri 虽设置最小窗口 840×620，但 Windows 文本缩放、浏览器 GUI 和未来小窗仍会暴露溢出。
5. **可访问性只是冒烟级。** 已有 `role=status`、`aria-live` 和键盘 Tab 测试，但没有 `:focus-visible`、`prefers-reduced-motion`、高对比模式、自动化 WCAG 扫描和视觉回归。
6. **部分颜色达不到普通文本 WCAG AA。** 按 WCAG 相对亮度公式计算：`#71717a` 在画布 `#0f1117` 上约 3.90:1、在卡片 `#1a1d27` 上约 3.48:1；白字在红色按钮 `#ef4444` 上约 3.76:1；均低于普通文本 4.5:1。当前大量 12–14px 文本使用这些组合。
7. **动作语义混杂。** “还原日常配置”使用红色，但它不是危险动作；真正破坏性的“移除中文字体”反而没有独立 danger 视觉层级。颜色应表达动作后果，而非仅用于区分按钮。

### 字体修复流的发布阻断缺陷

这部分与“GUI 自托管字体”是两层问题：自托管只能保证 CC-Fix 自己仍可显示中文，不能保证 Windows 字体被安全移除和还原。2026-08-26 对当前代码与本机状态做只读核对后，确认以下风险：

1. **备份不完整仍可继续删除。** 文件读取/复制失败会静默跳过，注册表读取失败会静默写成空表；`remove()` 随后仍调用提权删除。所谓“完整备份”只检查 `fonts/` 非空且能读取 `manifest.json`，没有要求“删除清单 = 备份清单”，也不验证清单大小和 SHA-256。
2. **还原不会撤销重启删除队列。** 删除失败的字体会追加进 Windows `PendingFileRenameOperations`；还原路径只是复制字体并清空 CC-Fix 自己的 marker，没有从系统队列删除由本次事务拥有的条目。用户先移除、再还原、最后重启时，已还原字体仍可能被系统删除。
3. **永久复用旧备份会降级系统字体。** `backup()` 发现任意既有“完整”备份就直接复用。当前机器 15 个命中字体均存在且备份哈希有效，但现场 `simhei.ttf` 已与 2026-08-15 的旧备份不同；再次移除/还原会把更新后的系统字体覆盖成旧版本。
4. **恢复没有完成后验证。** 恢复脚本未按 manifest 校验落盘文件的哈希/大小，未验证注册表读回，也未广播 `WM_FONTCHANGE`。Microsoft 的字体安装/删除说明要求配合字体资源 API，并在变更后广播 `WM_FONTCHANGE`；仅复制文件可能要等重启才进入字体表。
5. **检测语义把正常系统能力当高风险。** Windows 11 自带 Microsoft YaHei、SimSun 等字体，微软也明确把 Microsoft YaHei UI 推荐为简体中文 UI 字体。当前插件只要发现任一中文字体就贡献满额高风险，无法区分 Windows inbox、语言可选功能和用户额外安装字体。

因此发布顺序应调整为：**先停用默认“移除中文字体”入口 → 修复两阶段备份/删除事务与重启队列所有权 → 完成恢复后验证 → 再做 GUI 自托管字体**。在这些条件满足前，不能仅靠二次确认把功能重新开放。

微软一手资料：

- [Windows 11 字体清单](https://learn.microsoft.com/en-us/typography/fonts/windows_11_font_list)
- [Windows 应用排版与简体中文 UI 字体](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography)
- [字体安装和删除](https://learn.microsoft.com/en-us/windows/win32/gdi/font-installation-and-deletion)
- [`WM_FONTCHANGE`](https://learn.microsoft.com/en-us/windows/win32/gdi/wm-fontchange)
- [Windows 缺失字体与中文补充字体恢复](https://learn.microsoft.com/en-us/windows/deployment/windows-missing-fonts)

## 2. GitHub 对标项目

| 项目 | 与 CC-Fix 的相似点 | 字体与设计 | UI 架构/性能 | 可访问性、响应式与测试 | 可借鉴/不要照搬 |
|---|---|---|---|---|---|
| [privacy.sexy](https://github.com/undergroundwires/privacy.sexy) | 跨平台系统隐私/安全配置，Web + 本地桌面端，可生成并执行系统脚本 | 仓库直接提交 WOFF2/TTF，并用 `@font-face` + `font-display: swap` 自托管；字体、字号、媒体断点拆成独立 SCSS 令牌。[字体定义](https://github.com/undergroundwires/privacy.sexy/blob/master/src/presentation/assets/styles/_fonts.scss) · [字体资源](https://github.com/undergroundwires/privacy.sexy/tree/master/src/presentation/assets/fonts) · [排版令牌](https://github.com/undergroundwires/privacy.sexy/blob/master/src/presentation/assets/styles/_typography.scss) | Vue 组件化 + Electron，领域/应用/基础设施/展示层目录清晰；代价是运行时和依赖显著重于 CC-Fix。[package.json](https://github.com/undergroundwires/privacy.sexy/blob/master/package.json) · [组件树](https://github.com/undergroundwires/privacy.sexy/tree/master/src/presentation/components) | Cypress 覆盖 iPhone SE、13 寸笔记本、4K，专测横向溢出和布局偏移；另有大量 unit/integration tests。[视口矩阵](https://github.com/undergroundwires/privacy.sexy/blob/master/tests/e2e/support/scenarios/viewport-test-scenarios.ts) · [布局偏移](https://github.com/undergroundwires/privacy.sexy/blob/master/tests/e2e/no-unintended-layout-shifts.cy.ts) · [溢出](https://github.com/undergroundwires/privacy.sexy/blob/master/tests/e2e/no-unintended-overflow.cy.ts) | **借鉴自托管、样式令牌、视口回归和分层；不要为一个小型面板照搬 Electron/Vue 体量。**其自托管字体只有 Latin 等子集，不能解决 CC-Fix 的中文缺字，CC-Fix 必须额外打包 CJK 字形。 |
| [CheckCC](https://github.com/yacuo/check-cc) | 最直接的 Claude 环境风险检测竞品，信号卡片、评分、地区选择高度相近 | Tailwind 4 + 少量主题变量；暖色视觉和卡片化信息层级更像消费级产品。[全局样式](https://github.com/yacuo/check-cc/blob/main/src/app/globals.css) | Next.js/React，把检测器、布局、i18n、检测引擎拆开；响应式类覆盖多列到单列。[Detector](https://github.com/yacuo/check-cc/blob/main/src/components/detector/Detector.tsx) · [SiteFrame](https://github.com/yacuo/check-cc/blob/main/src/components/layout/SiteFrame.tsx) | 多语言和断点较完整，但 `package.json` 只有 build/lint，仓库未见单元或 E2E 测试命令。[package.json](https://github.com/yacuo/check-cc/blob/main/package.json) | **借鉴首屏结论、卡片密度和响应式信息重排；不要照搬字体策略与强脉冲动画。**CSS 使用 `--font-geist-sans`，但当前根布局未通过 `next/font` 定义该变量，中文仍回退本机苹方/微软雅黑/Noto；这与 CC-Fix 的字体移除场景同样不闭环。[根布局](https://github.com/yacuo/check-cc/blob/main/src/app/layout.tsx) |
| [WinUtil](https://github.com/ChrisTitusTech/winutil) | Windows 系统调优/修复工具，包含 GUI、配置驱动的系统写操作和还原语义 | 原生 WPF/XAML，主要继承 Windows 字体与控件；不是“删除系统字体后仍可显示中文”的参考实现 | 将应用/ tweak 数据放入 JSON，由统一 UI 自动生成；功能函数和视图分离，发布时再编译为单脚本。[架构文档](https://github.com/ChrisTitusTech/winutil/blob/main/docs/src/content/docs/code-reference/architecture.mdx) · [XAML](https://github.com/ChrisTitusTech/winutil/blob/main/xaml/inputXML.xaml) | Pester 校验 JSON 和 PowerShell 函数，并有 ScriptAnalyzer 约束；UI 自动化弱于 PowerToys。[AGENTS.md](https://github.com/ChrisTitusTech/winutil/blob/main/AGENTS.md) · [Pester](https://github.com/ChrisTitusTech/winutil/tree/main/pester) | **借鉴目录/信号/动作配置驱动，以及源代码模块化、发布物合并的思路。**不要照搬 WPF 巨型 XAML 或仅靠系统字体。 |
| [Microsoft PowerToys](https://github.com/microsoft/PowerToys) | 成熟 Windows 工具箱，涉及提权、设置、模块状态、安装和大量系统级操作 | WinUI/Fluent 语义资源，原生跟随 Light/Dark/High Contrast；用户文案使用资源文件，控件带 AutomationProperties。[新增模块指南](https://github.com/microsoft/PowerToys/blob/main/doc/devdocs/development/new-powertoy.md) | Settings 使用 View + ViewModel + 设置模型分层，模块化程度高；对 CC-Fix 来说完整照搬过重 | 专门的 UI 测试框架，可按窗口尺寸运行、用 Accessibility Insights 检查 UIA，并支持 VisualAssert 截图对比。[UI 测试指南](https://github.com/microsoft/PowerToys/blob/main/doc/devdocs/development/ui-tests.md) | **借鉴语义令牌、系统主题/高对比、可访问名称和视觉回归。**不要因追求“原生感”改写成 WinUI；WebView2 保留现有安全架构更划算。 |
| [Portmaster](https://github.com/safing/portmaster) | Windows/Linux 桌面隐私工具，核心服务以高权限运行，GUI 在用户上下文运行，与 CC-Fix 的 helper/sidecar 边界相近 | 仓库把 Roboto 各字重、格式和许可证一起作为应用资产分发。[字体资源](https://github.com/safing/portmaster/tree/development/assets/data/fonts) | Go 核心服务与用户态 UI 分离；庞大网络产品架构不适合直接移植 | 核心层有广泛 Go 测试，但近期中文本地化讨论仍需要额外的中文字体回退和布局调整。[中文本地化 issue](https://github.com/safing/portmaster/issues/2199) · [测试说明](https://github.com/safing/portmaster/blob/development/TESTING.md) | **借鉴“字体文件+许可证随包”和高权限核心/低权限 UI 分离。**它也证明只自托管 Latin Roboto 不足以支持中文；CC-Fix 必须从第一版字体资产就包含 SC 字形。 |
| [xd-AntiSpy](https://github.com/builtbybel/xd-AntiSpy) | Windows 10/11 隐私设置和系统 tweak GUI，支持插件、DPI 与多语言 | C# Windows 桌面 UI，依赖系统渲染；仓库有简中资源程序集，但不构成独立 CJK 字体保障。[本地化资源](https://github.com/builtbybel/xd-AntiSpy/tree/main/LocalizationLibrary/Locales) | JSON 插件让非开发者扩展批处理/PowerShell tweak，体量较小。[插件目录](https://github.com/builtbybel/xd-AntiSpy/tree/main/plugins) | README 明确把 DPI、插件和翻译列为能力，但未展示与 CC-Fix 同等级的字体移除恢复和 UI 自动化门禁。[README](https://github.com/builtbybel/xd-AntiSpy/blob/main/README.md) | **借鉴多语言资源与 JSON 插件边界；不要把“有 zh-CN 翻译”误当成“字体在任何系统状态都可用”。** |

### 字体上可直接采用的上游

- [Google Fonts 的 Noto Sans SC](https://github.com/google/fonts/tree/main/ofl/notosanssc) 使用 SIL Open Font License，包含可变字重字体；完整 TTF 约 16.9 MB，不能未经子集化直接塞进轻量 GUI。
- [Noto 官方 Web 使用说明](https://github.com/notofonts/noto-docs/blob/main/docs/website/use.md) 明确说明 CJK 变体与字形覆盖，并推荐 CJK 字体栈顺序。
- [Noto FAQ](https://github.com/notofonts/noto-fonts/blob/main/FAQ.md) 对“tofu/方框”成因和 CJK 仓库位置有直接说明。

不应从 Windows 安装目录复制并随 CC-Fix 再分发微软雅黑、宋体等微软字体；应使用 OFL 字体并将许可证、版本、来源和哈希纳入 `THIRD-PARTY-NOTICES`/发布证据。

## 3. 建议路线图

> 处理状态（2026-08-27）：系统安全 P0 已落地——默认移除入口停用、字体信号改为信息性、删除前新鲜完整备份及哈希复验、manifest 删除清单绑定、重启删除队列所有权、还原读回验证与 `WM_FONTCHANGE` 已实现；应用自有 CJK WOFF2、认证本地字体路由、OFL 来源/哈希和 GUI 资源测试也已落地。P1 的语义令牌、SVG 图标、响应式/无障碍护栏、多视口、200% 缩放、axe serious/critical 扫描和 375/840px 视觉基线已落地。P2 的 CSS/JS 外置、静态资产精确路由、CSP 移除 `unsafe-inline`、修复流纯 reducer，以及检测/字体子面板 renderer（含单测）均已落地；在增加新的 GUI 状态前无需引入框架或更大的状态库。

### P0：先修复“应用删除自己的显示依赖”

1. **打包应用自有 CJK WOFF2。**建议以 Noto Sans SC 为源，先覆盖 GUI 静态中文文案、ASCII、常用标点、地区名称和可能出现的错误字符；保留 400/600 两个实际使用字重，或评估一个可变字重子集。字体族命名为产品私有名称（如 `CCFix Sans SC`），避免和系统安装字体混淆。
2. **字体必须来自安装包/本地服务，不走 CDN。**由认证本地 GUI 服务提供带内容哈希的 `/assets/fonts/*.woff2`，响应 `Content-Type: font/woff2` 与长期 immutable cache；HTML 预加载关键字体，CSP 增加 `font-src 'self'`。HTML/API 保持 `no-store`，字体资产可单独缓存。
3. **首帧策略针对本地桌面优化。**`privacy.sexy` 的 `font-display: swap` 适合公网；CC-Fix 在系统 CJK 已被移除时可能先闪一次方框。应对本地 WOFF2 做 preload，并实测 `block` 与 `swap`；验收标准是冷启动、字体移除后启动、还原页三种场景均无 tofu，而不是机械采用某个值。
4. **不要只子集“当前截图中的字”。**动态错误、浏览器名、地区、时间和恢复消息也需要覆盖。构建脚本应从静态 HTML/TS 文案与明确的动态字形白名单生成 glyph set，并在 CI 对新增中文字符做缺字检查。
5. **为字体建立可验证契约。**Playwright 等待 `document.fonts.ready`，断言 `document.fonts.check('14px "CCFix Sans SC"', '中文字体还原失败')`，同时验证字体 URL 200、MIME 正确、无公网请求；再加一张“系统中文字体不可用”基线截图。安装包校验应确认 WOFF2 和 OFL 文件都存在且哈希固定。
6. **字体操作 UI 保持可恢复。**移除前明确展示备份已验证、预计影响和“应用自身仍可显示”的保证；移除后把“立即还原字体”置于稳定可见位置，不依赖仅由 emoji 表达的图标。

### P1：一轮完成 UI 可靠性与可访问性

1. **建立项目自己的 `design/DESIGN.md`。**以现有深色工具风格为事实源，可借鉴 [VoltAgent awesome-design-md 的 Linear 参考](https://github.com/VoltAgent/awesome-design-md/tree/main/design-md/linear.app)：4px 间距、分层 surface、12px 卡片圆角、8px 控件圆角、单一品牌强调色；但 CC-Fix 必须保留 success/warning/danger 语义色，不能照搬营销页“仅一色”。
2. **把所有视觉值改为语义令牌。**至少包含 `canvas/surface/elevated`、`text/secondary/disabled`、`border/focus`、`accent/success/warning/danger`、字号、行高、间距、圆角、控件高度。修正上述对比度不达标组合，并为 forced-colors/high-contrast 提供系统颜色回退。
3. **重新分配动作层级。**主按钮只保留当前推荐动作；“重新检测”为普通次按钮；“还原日常配置”为中性次按钮；“移除中文字体”才使用 danger 样式并带二次确认。状态不能只靠红/绿，继续保留图标+文字。
4. **补齐键盘与动画偏好。**所有 button/select/summary 提供明显的 `:focus-visible` 2px outline；为 spinner、pulse、flash、toast transition 增加 `prefers-reduced-motion: reduce`；长任务用可访问的进度/阶段文本，不让整个区域频繁重复播报。
5. **去 emoji 依赖。**盾牌、地球、房子、字体等操作图标换成随包 SVG，设 `aria-hidden=true`；关键状态永远由文字说明。emoji 字形同样依赖系统字体，且不同 Windows 版本视觉不一致。
6. **响应式不是只为手机。**增加至少 840、640、375 CSS px 和 200% zoom 布局：操作区从横排改为可换行/单列；信号表在窄宽时转为 label/value 卡片或允许受控横滚；地区/强度选择器换行；toast 不超出窗口；长路径/错误使用 `overflow-wrap:anywhere`。

### P2：在不牺牲轻量性的前提下拆前端

1. **不建议立刻引入 React/Vue。**当前列表规模小、DOM 更新频率低，框架收益不足以抵消包体、供应链和启动成本。保留原生 DOM，但把 `index.html`、`tokens.css`、组件样式、API/SSE 客户端、状态 reducer、视图渲染器拆开，由构建产物打包和内容哈希。
2. **先抽纯状态机，再抽组件。**把 `idle → checking → checked → fixing → recovery-required` 以及字体操作状态做成纯 reducer，视图只消费 state；单测状态组合，E2E 只验证关键用户路径。这样比继续让事件处理器直接改 DOM 更容易保证恢复语义。
3. **收紧 CSP。**拆出脚本/样式后去掉 `script-src 'unsafe-inline'` 与 `style-src 'unsafe-inline'`，只允许 self；服务端对静态资产做精确路由、MIME、ETag/immutable cache，对 HTML/API/SSE 继续 no-store/no-cache。
4. **保留当前性能优势。**13 个信号无需虚拟列表，也无需复杂状态库。性能预算应重点放在 CJK 字体：记录 WOFF2 总大小、冷启动 Font Loading、首个稳定布局时间和无布局偏移；避免引入仅为样式服务的大型依赖。

## 4. 建议新增的自动化门禁

| 门禁 | 最小验收 |
|---|---|
| 字体独立性 | WOFF2/OFL 在安装载荷；字体请求只访问 127.0.0.1；`document.fonts.check` 对关键中英文为真；字体移除后的恢复页截图无方框 |
| 可访问性 | `@axe-core/playwright` 无 serious/critical；Tab 顺序、可访问名、live region；`forcedColors: active`、`reducedMotion: reduce` 各一条 E2E |
| 对比度 | 语义令牌自动校验普通文本 ≥4.5:1、大文本 ≥3:1；禁用态作为显式例外记录 |
| 响应式 | 375×667、840×620、1120×760、3840×2160；另测 200% zoom；断言 `scrollWidth <= clientWidth`（明确允许横滚的容器除外） |
| 视觉稳定 | daily/standard/deep/recovery-required/font-removed 五张稳定截图；等待 fonts ready 与检测稳定信号后截图，避免假阳性 |
| 工程质量 | CSS/JS bundle 和字体大小预算；静态资产 MIME/CSP/cache header 测试；用户可见字符串禁止散落在视图逻辑中 |

## 5. 推荐实施顺序与完成定义

1. **字体资产 + 服务路由 + 字体契约测试**：这是发布阻断项；在它完成前，不应把“移除中文字体”视为产品级稳定功能。
2. **语义设计令牌 + 对比度/focus/reduced-motion + SVG 图标**：同一轮完成，避免反复改 CSS。
3. **响应式布局 + 多视口/缩放/overflow/截图门禁**：以恢复页和字体移除后状态为第一测试场景。
4. **原生前端模块化 + reducer + CSP 收紧**：功能不变的工程重构，单独提交，便于回归定位。
5. **再考虑视觉精修**：首屏突出“当前健康状态、推荐动作、可恢复保证”，详细信号与历史下沉。设计目标应是可信、克制、可读，而不是增加动画或装饰。

完成定义不是“CSS 中出现 Noto 名称”，而是：在中文系统字体已被 CC-Fix 移除、离线、Windows 高对比/200% 缩放条件下，桌面 GUI 仍能完整显示中文、键盘可操作、恢复入口可见，且安装载荷和 CI 能证明字体来源、许可证与加载成功。
