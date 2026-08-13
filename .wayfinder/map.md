# Wayfinder Map: CC-Fix Windows Productization v0.2

## Destination

把 CC-Fix 从依赖系统 Node 的实验性 CLI 收口为可恢复、可审计的 Windows 产品：统一 CLI/桌面 GUI 状态语义，提供日常/标准/深度三态保护、四地区原子切换、崩溃恢复，以及无需预装 Node 的单文件离线安装器和可验证发布证据。

## Current baseline

- 版本：`0.2.0-rc.1`；版本、工具链、文档一致性均有 fail-closed 门禁。
- 平台：Windows 11 x64 为公开主线；Windows 10 22H2 仅遗留兼容目标。
- 核心：Node.js 24 LTS 私有运行时 + 单文件 ESM bundle。
- 桌面：Tauri v2 / WebView2，localhost 会话认证、单实例和受控 sidecar 生命周期。
- 安装：Inno Setup 6.7.x per-user 离线单 EXE，固定 AppId、开始菜单、可选桌面/PATH、修复、降级拒绝和 restore-first 卸载。
- 状态：显式 state v1、不可覆盖 backup v4、journal、活锁识别、校验写入、前代恢复、读回验证、完整补偿与收敛式 off/recover。
- 发布：GitHub Windows CI、CycloneDX SBOM、第三方声明、构建信息、SHA-256、artifact attestation 和 draft release 门禁。

## Decisions so far

- 标准保护为默认，保留 Windows 日常语言/区域偏好；深度保护才对齐 Locale、语言列表与 Culture。
- `us/eu/jp/sg` 使用同一合法地区目录；非法地区显式失败，不静默回落 US。
- 保护模式只来自完整成功提交；健康、活动事务和恢复需要独立表达，不能从备份存在推断。
- 首次离开日常状态时保存不可覆盖原始快照；换区、升级、降级和重复对齐不得污染日常基线。
- VPN、路由器、路由表、网卡、DNS、hosts 与 DoH 永远只读检测和提醒，不提供修改入口。
- Windows 安装包内置固定来源和 SHA-256 的 Node、WebView2、Tauri、Rust 与 Inno 工具链。
- 无签名 RC 必须明确审批和警告；未配置 Authenticode 身份时禁止发布 stable。

## Remaining release gates

- 在独立 Windows 11 25H2 与 24H2 客户端完成发布矩阵；26H1 仅手工冒烟，Windows 10 22H2 仅遗留验证。
- 配置 Authenticode 证书并验证 SHA-256/RFC3161 时间戳与一致发布者，才能发布签名 stable。
- 在仓库侧配置 npm Trusted Publishing/OIDC 后，才启用与 GitHub Release 同版本、同提交的 npm 正式渠道。
- 首个公开 RC 验证通过后冻结代码；stable 只能包含允许的版本元数据和发布说明差异。

## Out of scope

- 修改 VPN、路由器、路由表、网卡、DNS、hosts 或 DoH。
- 自动更新、系统级全用户安装和多个正式版本并存。
- macOS/Linux 桌面安装包。
- 承诺 SmartScreen 对新文件绝不提示；签名有效性是确定门禁，信誉提示不是。
