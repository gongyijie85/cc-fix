# check-cc 代码复用评估报告

> 评估对象：[check-cc](https://github.com/yacuo/check-cc) v0.1.0  
> 评估目标：基于 check-cc 构建 CLI 命令行工具（自动检测并修复 Claude Code 运行环境安全风险）  
> 评估日期：2026-08-06

---

## 1. 可直接复用的模块

以下模块为纯逻辑代码，不依赖浏览器 API，可直接在 Node.js 环境中运行：

| 模块路径 | 用途 | 复用方式 |
|---------|------|---------|
| `src/detection/types.ts` | 核心类型定义（RegionCode、AccessStatus、SignalResult、RegionProfile、IpIntelligence 等） | 直接引用，需移除 `SignalSource` 中 `"browser"` 的语义约束 |
| `src/detection/scoring.ts` | 风险评分引擎：根据地区画像和信号计算 Claude 产品访问状态与分数 | 直接复用，`evaluateAccess()`、`accessStatus()` 均为纯函数 |
| `src/detection/config/*` | 检测配置体系（信号权重、运行器模式、步骤、服务配置） | 全部直接复用，配置结构与运行环境无关 |
| `src/detection/plugin.ts` | 插件接口定义（DetectionPlugin、DetectionPluginContext） | 直接复用类型定义，但需调整 `browser` 字段的来源 |
| `src/detection/runner.ts` | 检测运行器：收集信号、执行插件、去重 | 需小幅改造：`collectBrowserEnvironment` 调用需替换为 Node.js 实现 |
| `src/detection/plugins/index.ts` | 插件注册入口 | 直接复用，按 CLI 需求裁剪插件列表 |
| `src/regions/index.ts` | 地区画像规则（CN/RU/IR 的国家、时区、语言、字体、产品可用性特征） | 完全复用，纯数据定义 |
| `src/detection/plugins/timezone.ts` | 时区检测插件 | 复用逻辑，数据源改为 Node.js `Intl.DateTimeFormat()` |
| `src/detection/plugins/timezone-offset.ts` | 时区偏移检测插件 | 复用逻辑，`new Date().getTimezoneOffset()` 在 Node.js 中同样可用 |
| `src/detection/plugins/language.ts` | 语言检测插件 | 复用逻辑，数据源改为 Node.js `os.userInfo()` 或环境变量 |
| `src/detection/plugins/locale.ts` | Intl 区域设置检测插件 | 复用逻辑，Node.js 支持 `Intl.DateTimeFormat().resolvedOptions().locale` |
| `src/detection/plugins/emoji-style.ts` | Emoji 渲染风格检测插件 | 逻辑可复用，但检测方式需从 canvas 渲染改为文件/进程探测 |
| `isPublicIp()` (client-engine.ts L159-165) | 判断 IP 是否为公网 IP 的工具函数 | 直接复用，纯逻辑 |
| `signalsScore()` (client-engine.ts L167-176) | 综合信号评分计算 | 直接复用，纯逻辑 |

---

## 2. 需要适配的模块

以下模块包含浏览器特定 API 调用，需适配为 Node.js 等效实现：

| 模块路径 | 当前实现 | 适配方案 | 工作量估算 |
|---------|---------|---------|-----------|
| `src/detection/client-engine.ts` — `collectBrowserEnvironment()` | 使用 `navigator.languages`、`navigator.userAgent`、`navigator.userAgentData` | 替换为 Node.js 数据源：`os.userInfo()`、`process.env.LANG`、`Intl.DateTimeFormat().resolvedOptions()`、自定义 UA 字符串（模拟 Claude Code 的 Node.js 请求） | **中（2-3h）** |
| `src/detection/client-engine.ts` — `collectBrowserSignals()` | 调用 `hasFont()` 依赖 canvas 2D 渲染检测字体 | 字体检测改为：扫描系统字体目录（Windows: `C:\Windows\Fonts`，macOS: `/System/Library/Fonts`，Linux: `fc-list`），或检查已安装字体包 | **中（2-3h）** |
| `src/detection/client-engine.ts` — `hasFont()` | 使用 `document.createElement("canvas")` + `ctx.measureText()` 做字体探测 | 替换为系统字体列表查询（`font-list` npm 包或原生 `child_process` 调用 `fc-list`/PowerShell） | **小（1-2h）** |
| `src/detection/client-engine.ts` — `animateProgress()` | 浏览器进度条动画 | CLI 中替换为终端进度条（`ora` 或 `cli-progress`），或移除（CLI 无需动画） | **小（0.5h）** |
| `src/detection/client-engine.ts` — `detectBrowserName()`/`detectOS()`/`detectDeviceName()` | 解析浏览器 UA 字符串 | 在 CLI 场景中改为检测 Node.js 版本、`package.json` 依赖、Claude Code CLI 版本等；或保留用于分析 Claude Code 发出的 HTTP 请求的 UA | **小（1h）** |
| `src/detection/plugins/emoji-style.ts` | 依赖浏览器 canvas 渲染差异检测 emoji 风格 | CLI 中改为检测系统类型推断 emoji 风格（Windows → Windows Emoji，macOS → Apple Emoji），或移除该信号 | **小（1h）** |
| `src/detection/plugins/language-variant.ts` | 依赖浏览器 `navigator.languages` 判断简繁体 | 改为读取系统 locale（`os.userInfo().locale`、`process.env.LANG`） | **小（0.5h）** |
| `src/detection/plugins/browser-environment.ts` | 调用 `collectBrowserSignals()` | 适配后自动跟随 `client-engine.ts` 的改造 | **小（含在 client-engine 改造中）** |
| `src/detection/locale.ts` | 检测模块本地化文案 | 保留数据结构，CLI 中可简化为仅保留中文/英文，文案通过终端输出 | **小（0.5h）** |
| `src/detection/runner.ts` — `runDetection()` | 调用 `collectBrowserEnvironment(context.text)` | 将 `text` 参数改为 CLI 上下文对象（包含 Node.js 环境信息） | **小（0.5h）** |

---

## 3. 不可复用的模块

以下模块为纯前端 UI 代码，与 CLI 工具完全无关：

| 模块路径 | 原因 |
|---------|------|
| `src/app/page.tsx` | Next.js 页面组件，包含 SEO JSON-LD、FAQ 渲染等纯 Web 逻辑 |
| `src/app/layout.tsx` | Next.js 根布局，HTML 结构、字体加载 |
| `src/app/globals.css` | 全局 CSS 样式 |
| `src/app/[locale]/` | Next.js 国际化路由页面 |
| `src/components/detector/Detector.tsx` | React 检测器 UI 组件（20.5KB），包含状态管理、进度动画、结果展示 |
| `src/components/layout/SiteFooter.tsx` | React 页脚组件 |
| `src/components/layout/SiteFrame.tsx` | React 页面框架组件（导航栏、布局） |
| `src/i18n/messages.ts` | 完整的 Web 页面多语言文案（147 行），CLI 仅需其中检测模块相关文案 |
| `public/` | 静态资源（favicon、图片等） |
| `next.config.ts` | Next.js 框架配置 |
| `postcss.config.mjs` | PostCSS 配置 |
| `eslint.config.mjs` | ESLint 配置（可参考但需重写） |
| `tsconfig.json` | TypeScript 配置（路径别名 `@/` 可复用） |

---

## 4. 依赖评估

### 现有依赖分析

| 依赖 | 版本 | CLI 是否需要 | 说明 |
|------|------|-------------|------|
| `next` | 16.2.10 | ❌ 不需要 | Next.js 框架，CLI 不使用 |
| `react` | 19.2.4 | ❌ 不需要 | UI 框架 |
| `react-dom` | 19.2.4 | ❌ 不需要 | UI 渲染 |
| `typescript` | ^5 | ✅ 需要 | 开发时依赖 |
| `tailwindcss` | ^4 | ❌ 不需要 | CSS 框架 |
| `@tailwindcss/postcss` | ^4 | ❌ 不需要 | PostCSS 插件 |

### CLI 版本需要的额外依赖

| 依赖 | 用途 | 必要性 |
|------|------|--------|
| `commander` 或 `yargs` | CLI 参数解析 | **必需** |
| `chalk` 或 `picocolors` | 终端彩色输出 | **必需** |
| `ora` | 终端 loading 动画 | 推荐 |
| `cli-table3` | 终端表格输出（展示信号结果） | 推荐 |
| `inquirer` 或 `prompts` | 交互式确认（修复前确认） | 推荐 |
| `axios` 或 `undici` | HTTP 请求（IP 情报查询） | 按需（Node 20+ 内置 `fetch`） |
| `font-list` | 系统字体检测（替代 canvas 字体探测） | 按需（也可用 `child_process` 原生实现） |
| `envinfo` | 系统环境信息采集 | 可选 |
| `semver` | 版本号比较（检测 Node.js 版本等） | 可选 |
| `vitest` 或 `jest` | 单元测试 | 开发时依赖 |
| `tsup` 或 `esbuild` | 打包为单文件可执行 | 开发时依赖 |
| `@types/node` | Node.js 类型定义 | 开发时依赖 |

---

## 5. 总体工作量估算

### 适配工作总量

| 工作项 | 估算时间 | 说明 |
|--------|---------|------|
| 项目脚手架搭建（CLI 初始化、tsconfig、打包配置） | 2h | 使用 `commander` + `tsup` 搭建基础框架 |
| 核心检测逻辑迁移（types、scoring、config、regions） | 1h | 直接复制，调整 import 路径 |
| `client-engine.ts` 适配（浏览器 → Node.js 环境采集） | 3-4h | 最大工作量：字体检测、UA 模拟、环境信息源替换 |
| 插件系统适配（7 个插件逐一调整） | 2-3h | 每个插件改动较小，但需逐一验证 |
| IP 情报服务对接（HTTP 请求改为 Node.js） | 1h | 使用内置 `fetch` 或 `undici` |
| CLI 输出层（终端 UI、进度条、结果表格） | 2-3h | 新建代码，不复用 check-cc |
| 修复功能实现（CLI 独有，check-cc 无此功能） | 4-6h | 全新开发：环境变量修改建议、代理配置、hosts 文件等 |
| 测试编写 | 2-3h | 单元测试 + 集成测试 |
| **总计** | **约 17-25h（2-3 个工作日）** | |

### 可复用代码比例

- **可直接复用**：约 40% 的检测逻辑代码（types、scoring、config、regions、部分 plugins）
- **需适配后复用**：约 35% 的检测逻辑代码（client-engine、插件数据源）
- **不可复用**：约 25% 的总代码量（UI 组件、页面、样式、i18n 文案）
- **CLI 独有新增**：修复功能、终端 UI、交互逻辑（约占最终代码量 50%）

### 建议的实施顺序

1. **Phase 1 — 基础框架（2h）**
   - 初始化 CLI 项目（`commander` + `tsup` + `typescript`）
   - 复制可直接复用的模块（types、scoring、config、regions）
   - 验证 `evaluateAccess()` 在 Node.js 中正常运行

2. **Phase 2 — 环境采集适配（4h）**
   - 改造 `client-engine.ts`：实现 Node.js 版 `collectEnvironment()`
   - 实现系统字体检测替代方案
   - 改造 `collectSignals()` 适配 Node.js 数据源

3. **Phase 3 — 插件系统迁移（2h）**
   - 迁移并适配 7 个检测插件
   - 调整 `runner.ts` 适配 CLI 上下文
   - 确保 `runDetection()` 端到端通过

4. **Phase 4 — CLI 交互层（3h）**
   - 实现终端输出（chalk + ora + cli-table3）
   - 实现命令行参数解析
   - 实现 JSON / 文本双模式输出

5. **Phase 5 — 修复功能（5h）**
   - 设计修复规则引擎（基于检测信号生成修复建议）
   - 实现自动修复能力（环境变量、代理配置、DNS 等）
   - 实现修复前确认和回滚机制

6. **Phase 6 — 测试与打包（2h）**
   - 编写单元测试
   - 打包为单文件可执行程序
   - 跨平台测试（Windows / macOS / Linux）
