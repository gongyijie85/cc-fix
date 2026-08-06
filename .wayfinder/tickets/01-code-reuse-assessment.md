# Ticket: check-cc 代码复用评估

**类型**: `wayfinder:research` (AFK)
**状态**: Open / Unclaimed
**阻塞**: 无

## Question

check-cc 的哪些模块可以直接复用到 CLI 工具中？

具体需要评估：

1. **可直接复用**（浏览器无关）：
   - `src/detection/types.ts` — 类型定义
   - `src/detection/scoring.ts` — 评分逻辑
   - `src/detection/runner.ts` — 检测运行器
   - `src/detection/plugin.ts` — 插件接口
   - `src/regions/` — 地区画像配置

2. **需要适配**（浏览器 → Node.js）：
   - `src/detection/client-engine.ts` — 浏览器环境采集，需要改为 Node.js 系统信息采集
   - 各 plugins（timezone、language、locale 等）— 需要从浏览器 API 改为系统 API

3. **不可复用**（纯浏览器端）：
   - `src/components/` — React UI 组件
   - `src/app/` — Next.js 页面路由
   - `src/i18n/` — 可能需要简化为 CLI 输出格式

4. **依赖评估**：
   - 项目依赖极简（next, react, react-dom, tailwind）
   - CLI 版本可能需要额外依赖：CLI 框架（commander/yargs）、系统信息库、chalk 等

**输出**：一份模块分类清单 + 适配工作量估算
