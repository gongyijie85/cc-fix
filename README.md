# CC-Fix

CC-Fix 是面向 Windows 的环境一致性检测与可恢复保护工具。它提供独立桌面应用、CLI 和本地 GUI，用同一套耐久事务管理环境变量、系统时区、浏览器策略以及可选的语言/区域画像。

当前版本：`0.2.0-rc.1` · 协议：MIT · 目标平台：Windows 10/11 x64

## 功能亮点

- **三档保护模式**：`daily` / `standard` / `deep`，可随时查看健康状态与切换。
- **耐久事务**：写前计划、写后读回验证、失败自动补偿、完整还原，不依赖“备份文件是否存在”推断安全。
- **只读网络检测**：VPN、路由、网卡、DNS、hosts 与 DoH 风险只检测、解释和提醒，绝不修改这些网络配置。
- **浏览器策略**：标准保护管理 Chrome/Edge 各 3 个 HKCU 策略槽（语言与 WebRTC 防泄漏）。
- **多端一致**：桌面应用、CLI 与本地 GUI 共用同一套核心逻辑和状态语义。
- **低门槛安装**：当前用户安装、无需管理员权限，自带 Node.js 24 私有运行时与 WebView2 离线安装程序。
- **可追溯发布**：发布载荷包含 SHA-256、CycloneDX SBOM、第三方声明、构建信息与来源证明。

## 重要边界

- CC-Fix 会检测出口网络、VPN、路由、网卡、DNS、hosts 与 DoH 风险，但只给出提醒，绝不修改这些网络配置。
- “标准保护”会修改当前用户的 `TZ`、`LANG`、`LC_ALL`，Windows 系统时区，以及 Chrome/Edge 的 6 个受管策略槽。
- “深度保护”还会修改 `LocaleName`、首选语言列表和用户 Culture，因此会更明显地影响日常 Windows 体验。
- 所有受管值在首次保护前写入不可变日常快照；关闭保护时逐项读回验证并完整还原。
- 安装包目前未进行 Authenticode 签名，Windows SmartScreen 可能显示未知发布者警告。请先核对随包 SHA-256。

## 安装

### Windows 桌面版（推荐）

运行 `CC-Fix-Setup-0.2.0-rc.1-x64.exe`。安装器：

- 安装到 `%LOCALAPPDATA%\Programs\CC-Fix`，无需管理员权限；
- 自带 Node.js 24 私有运行时，不要求系统安装 Node.js；
- 自带 x64 WebView2 离线安装程序，系统缺失时自动安装并复检；
- 创建开始菜单入口，可选桌面快捷方式和当前用户 PATH；
- 升级/修复前检查未完成事务；普通卸载会先执行完整日常还原。

安装包和校验文件由以下命令生成：

```powershell
pnpm build:installer
pnpm release:evidence
```

### npm CLI（兼容渠道）

如果只需要 CLI，也可使用系统 Node.js 20 或更高版本：

```powershell
npm install -g cc-fix
cc-fix --version
```

仓库中的 `scripts/install.ps1` 与 `scripts/cc-fix.bat` 仅用于旧 npm CLI 兼容，不是独立 Windows 安装器。

## 快速开始

```powershell
# 检测；地区支持 us / eu / jp / sg
cc-fix check --region us

# 默认标准保护
cc-fix persist on --region us

# 深度保护（会额外改变语言和区域画像）
cc-fix persist on --level deep --region jp

# 查看已提交模式、健康状态和事务
cc-fix persist status
cc-fix persist status --json

# 继续未完成的恢复事务
cc-fix persist recover

# 完整还原日常配置
cc-fix persist off

# 只在子进程中注入目标环境，不改变持久状态
cc-fix run --region eu claude
```

桌面应用和 `cc-fix gui` 共用经过会话认证的 `127.0.0.1` 服务。启动令牌一次性使用，API/SSE 同时检查 Host、Origin 和会话 Cookie。

## 三种模式

| 模式 | 受管范围 | 适用场景 |
|---|---|---|
| `daily` | 不施加保护；保留偏好地区 | 日常使用 |
| `standard` | 环境变量、系统时区、Chrome/Edge 策略 | 默认、低干扰保护 |
| `deep` | 标准保护 + LocaleName、语言列表、Culture | 明确接受系统语言/区域变化时 |

模式和健康状态彼此独立。`healthy`、`degraded`、`recovery_required` 来自已提交状态和事务日志，不通过“备份文件是否存在”推断。

## 状态与恢复

状态目录为 `%APPDATA%\cc-fix`，主要文件包括：

- `state.json`：已提交目标、偏好地区、健康状态和活动事务；
- `persist-backup.json`：首次保护前的不可变 v4 日常快照；
- `transaction-journal.json`：写前计划、逐项验证和补偿进度；
- `migration-evidence`：旧 v3 状态迁移的只读证据。

不要在受保护或恢复未完成时手工删除这些文件。遇到未完成事务时，先运行 `cc-fix persist recover`，不要直接开始新的保护转换。

## 浏览器策略

标准保护管理 Chrome 与 Edge 各 3 个 HKCU 策略槽：

- `AcceptLanguages`
- `DefaultWebRtcIPHandlingPolicy`
- `ApplicationLocaleValue`

浏览器通常需要重启才能采用新策略。如果策略区被组织策略或 ACL 拒绝，已知的“受管/拒绝”错误会记录为降级；未知错误仍按致命错误处理。

## 安装、升级和卸载安全

- 同版本再次安装执行修复，不改变 `%APPDATA%\cc-fix` 状态。
- 安装器拒绝用较旧的 SemVer（包括 RC 序号）覆盖较新版本；需要回退时先保留状态卸载，再安装能安全读取现有 schema 的版本。
- 存在活动或待恢复事务时，升级/修复会停止，并要求先运行 `cc-fix persist recover`。
- 普通卸载先运行 `persist off`；还原失败时停止卸载，保留程序和恢复数据。
- 紧急情况下可用 `unins000.exe /PRESERVESTATE` 只移除程序并保留全部恢复数据；重新安装后必须立即执行 `persist recover` 或 `persist off`。
- PATH 卸载只移除安装器拥有的精确 `CC-Fix\bin` 段，不改动其他条目。

## 验证与构建

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:gui
cargo test --locked --manifest-path native-helper/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
pnpm build:installer
pnpm verify:payload
pnpm release:evidence
pnpm verify:evidence
pnpm test:windows
```

Windows 生命周期测试会在隔离的工作区目录和 APPDATA 中完成安装、降级拒绝、修复、私有运行时 CLI、桌面单实例、sidecar 回收、PATH 和卸载验证；它只读取并比较 VPN/路由/网卡/DNS 配置指纹，不修改这些配置。

确切的 Node、Rust、Tauri、Inno Setup 与 WebView2 来源及 SHA-256 位于 `toolchain.lock.json`。发布载荷还会生成 CycloneDX SBOM、第三方声明、构建信息和安装包摘要。

## 开发

- [CONTRIBUTING.md](CONTRIBUTING.md)：环境要求、验证命令、代码风格与 PR 流程。
- `pnpm install` 自动接线 pre-commit 门禁（`typecheck` + `test`，紧急情况可 `git commit --no-verify`）。
- `pnpm dev` 以 watch 模式构建 `dist/`；`cc-fix check --debug` 输出耗时与错误堆栈，便于提交问题。

## Windows 支持

- 主验证线：Windows 11 25H2 x64；
- 兼容线：Windows 11 24H2 x64；
- Windows 11 26H1：新设备手工冒烟；
- Windows 10 22H2：仅作为已结束常规支持的遗留兼容目标。

## 文档

- [SPEC.md](SPEC.md)：规格索引与当前不变量；
- [docs/spec/windows-productization-v0.2.md](docs/spec/windows-productization-v0.2.md)：Windows 产品化权威规格；
- [docs/release-guide.md](docs/release-guide.md)：RC/正式版发布操作步骤；
- [CONTEXT.md](CONTEXT.md)：领域术语与统一事件协议；
- [docs/adr/](docs/adr/)：架构决策记录；
- [docs/agents/](docs/agents/)：Agent 工作流与 Issue 约定。

## 开源协议

本项目使用 MIT License。第三方组件遵循各自协议，发布证据中的 `THIRD-PARTY-NOTICES.md` 提供组件清单。
