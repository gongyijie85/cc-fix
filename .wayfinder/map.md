# Wayfinder Map: CC-Fix Phase 2 — 检测维度补全与增强

## Destination

将 cc-fix 从当前的 **4 个检测插件**（时区/语言/Locale/一致性）扩展到 **SPEC 规定的全部中优维度**，并对标 checkcc.org 的高价值检测项，使 CLI 端检测覆盖度从 ~30% 提升到 ~80%。同时修复已知缺陷、增强用户体验。

## Notes

- 领域：Claude Code 环境安全检测 CLI 工具
- 当前版本：v0.1.0，已实现 4 个高优检测 + IP 情报 + persist/run/proxy 命令
- 上游参考：checkcc.org 有 48 个检测维度，CLI 端可映射约 12 个
- 技术栈：TypeScript / Node.js CLI / commander.js / vitest
- 工作目录：`D:\cc-fix`（独立仓库，推送 github.com/gongyijie85/cc-fix）
- 每个插件需附带单元测试

## Decisions so far

<!-- Phase 1 已完成 -->

- [check-cc 代码复用评估] — 40% 直接复用，35% 适配，25% 不可复用
- [CLI 检测维度设计] — 18 个维度：4 高优 + 8 中优 + 6 低优
- [自动修复能力调研] — 6 项修复能力，备份+回滚机制
- [CLI 工具架构设计] — 单包 + commander.js，4 命令

<!-- Phase 2 决议 -->

- [中优插件优先级](tickets/05-medium-priority-plugins.md) — 实现 6 个中优插件：字体(10)/DNS(8)/BASE_URL(8)/代理(6)/Win区域(4)/UTC偏移(4)，总权重 125 归一化
- [IP情报增强](tickets/06-ip-intelligence-enhancement.md) — 多源对比(+15)+数据中心ASN判断(+13)，硬编码云厂商ASN清单
- [插件实现规格](tickets/07-plugin-implementation-spec.md) — 6 个插件全部无新增依赖，用 node:dns/child_process/fs 实现

## Not yet specified

- **中优检测插件实现**：DNS / 字体 / 代理配置 / BASE_URL / Windows 区域格式 / UTC 偏移 — 哪些先做？权重如何分配？
- **IP 情报增强**：多源对比（checkcc.org 的 +15 分项）、住宅/数据中心判断（+13 分项）
- **npm 发布**：尚未登录 npm，需要发布流程
- **macOS/Linux 平台适配**：PlatformAdapter 接口已预留，但 Phase 2 是否实现？

## Out of scope

- 浏览器端检测（WebRTC、Client Hints 等）— CLI 场景不适用
- 服务端边缘分析（Cloudflare 边缘机房）— 需服务端，CLI 无法实现
- 系统级修改（改注册表时区）— 已决策不做
- GUI 界面 — 已排除
