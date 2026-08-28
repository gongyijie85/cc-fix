# 贡献指南

感谢参与 CC-Fix 开发。本项目是面向 Windows 的环境一致性检测与可恢复保护工具（TypeScript 核心 + Rust 原生辅助 + Tauri 桌面壳）。

## 环境要求

**日常开发（核心）**

- Windows 10/11 x64（本产品目标平台；核心逻辑在 Node 上运行，但平台适配与测试以 Windows 为主）
- Node.js ≥ 20（推荐 24，与私有运行时一致）
- pnpm（仓库使用 pnpm workspace 与 `pnpm-lock.yaml`）
- 建议安装一次 `scripts/prepare-hooks.mjs` 接线的 pre-commit 门禁，`pnpm install` 会自动执行

**完整发布链（可选，仅安装器/桌面壳需要）**

- Rust 1.93.0（必须与 `toolchain.lock.json` 完全一致；`pnpm check:toolchain` 校验）
- Inno Setup 6.7.x（安装器构建；`pnpm build:installer` 会强校验精确版本）
- WebView2 离线安装器与 Node 私有运行时由 `scripts/build-windows-payload.ps1` 按锁文件自动下载

## 初次启动

```powershell
git clone https://github.com/gongyijie85/cc-fix.git
cd cc-fix
pnpm install --frozen-lockfile   # 自动接线 pre-commit 门禁（typecheck + test）
```

## 验证命令

```powershell
pnpm typecheck         # tsc --noEmit（严格模式，含 noUnusedLocals/Parameters）
pnpm test              # Vitest 全部单元/集成测试（68 文件 / 688+ 用例）
pnpm test:integration  # persist runtime + GUI server + CLI 集成
pnpm test:gui          # GUI 单测 + Playwright E2E（首次需 pnpm exec playwright install chromium）
pnpm test:coverage     # 覆盖率门禁（全局 80% 行/语句/函数，75% 分支；domain/state/persist 分支 90%）
cargo test --locked --manifest-path native-helper/Cargo.toml   # 原生辅助 Rust 测试
cargo test --locked --manifest-path src-tauri/Cargo.toml       # 桌面壳 Rust 测试
pnpm check:version && pnpm check:docs && pnpm check:toolchain  # 一致性门禁
```

提 PR 前至少运行 `pnpm typecheck` + `pnpm test`（pre-commit 门禁同款）。改动涉及 CI 门禁脚本时另跑 `pnpm check:ci-gates`。

## 代码风格

- **TypeScript 严格模式**：`strict: true` + `noUnusedLocals` + `noUnusedParameters` + `noImplicitReturns`，不写 `any`，依赖类型推断。
- **ESM**：import 路径以 `.js` 结尾（`import { x } from "../state/paths.js"`）。类型导入用 `import type`。
- **函数式优先**：`map`/`filter`/`flatMap` 而非循环；`const` 优先；早返回替代 `else`；不无谓解构。
- **注释**：解释“为什么”而非“是什么”；关键安全/事务语义附 ADR 引用（如 `// ADR-0006`）。日常代码可用中文注释。
- **测试**：与源码同目录 `*.test.ts`，测试真实实现，不 mock 掉被测对象；不覆盖测试无法触及的“不可能场景”。
- **API/公共契约**：CLI 退出码、JSON 信封（`schemaVersion`）、SSE 事件类型均为公开契约，改动必须同步规格与测试。

## 提交与 PR 流程

- 分支建议：`feat/<scope>-<slug>` / `fix/<scope>-<slug>` / `refactor/<slug>`。
- Commit 使用 Conventional Commits（如 `fix(persist)`、`perf(gui)`、`docs:`、`chore:`），一个提交聚焦一个问题。
- pre-commit 门禁（typecheck + test）通过才能提交；紧急情况 `git commit --no-verify` 后需尽快补验。
- PR 到 `main`，CI（`.github/workflows/verify.yml`）会在 `windows-2025` 上跑完整验证链（类型、测试、覆盖率、许可证/密钥/漏洞门禁、Playwright、Rust、安装包构建与证据校验、Windows 生命周期）。

## 调试

- `pnpm dev`：tsup watch 构建 `dist/`，随后 `node dist/index.js <命令>` 使用新产物。
- `cc-fix check --debug`：输出 IP 情报与检测流水线耗时到 stderr，崩溃时附加错误堆栈。
- GUI 本地调试：`node dist/index.js gui --port 3456`。
- 领域术语与事件协议见 `CONTEXT.md`；架构决策见 `docs/adr/`。

## 已知边界

- **禁止修改** VPN、路由器、路由表、网卡、DNS、hosts、DoH 配置（ADR-0009：只检测、解释、提醒）。
- Windows 产品化的权威契约是 `docs/spec/windows-productization-v0.2.md` 与 ADR 0004–0010；与实现冲突时先开决策，不在代码里隐式决定。
- `scripts/prepare-hooks.mjs` 只影响本仓库工作区，绝不改消费方 git 配置。
