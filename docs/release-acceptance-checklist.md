# CC-Fix 真实客户端验收手册（ADR-0010）

> 本手册用于 **stable 晋级前**的必做验收。`v0.2.0-rc.1` 已公开为 prerelease；只有在本手册全部通过、P0/P1/release-blocking-P2 清零后，才允许触发 `promote.yml` 晋级 stable。
> CI runner（windows-2025）不能替代真实客户端验收。

## 前置

- 被检安装包：`CC-Fix-Setup-X.Y.Z-rc.N-x64.exe`（下载自 Release 资产）
- 核对安装包 SHA-256（随包 `.sha256` 文件）
- 建议同时校验 `build-info.json`（version/commit/toolchain）、`sbom.cdx.json`、`THIRD-PARTY-NOTICES.md`
- 基础检查：`cc-fix check --region us`、`cc-fix --version`

## 测试线矩阵

| 线 | 系统 | 必须执行 |
|---|---|---|
| **主验证线** | Windows 11 **25H2 x64** | 完整安装生命周期矩阵（见下） |
| **兼容线** | Windows 11 **24H2 x64** | 核心子集（安装/CLI/单实例/PATH/卸载） |
| **新设备线** | Windows 11 **26H1 x64** | 正式版手工冒烟（安装 + check + persist on/off） |
| **遗留兼容线** | Windows 10 **22H2 x64** | 安装 + 核心功能验证（不承诺上游安全修复） |

## 主验证线完整矩阵

> 条目对应 `scripts/windows/Test-InstallerLifecycle.ps1` 的断言；CI 上的 `pnpm test:windows` 已覆盖登记项，但**必须在真实客户端复跑**（尤其 `persistSmoke` 依赖真实 `Get-WinUserLanguageList`，CI runner 恒跳过）。

1. **全新安装**：当前用户安装、无需管理员；落到 `%LOCALAPPDATA%\Programs\CC-Fix`；WebView2 缺失时自动安装并复检
2. **私有运行时 CLI**：`runtime\node.exe core\index.js --version` == 安装包版本
3. **桌面单实例**：二次启动聚焦已有窗口（不新开）
4. **sidecar 回收**：关闭桌面壳后私有 Node GUI 进程退出（无残留）
5. **降级拒绝**：安装较旧 SemVer（含 RC 序号）→ 拒绝覆盖
6. **同版本修复**：重跑同版执行修复，不改变 `%APPDATA%\cc-fix` 状态
7. **还原优先卸载**：普通卸载先 `persist off`；还原失败则中止卸载并保留程序与恢复数据
8. **PATH 精确还原**：卸载后 `HKCU\Environment\Path` 与安装前**逐字符一致**（仅移除安装器自有 `bin` 段）
9. **网络只读不变量**：VPN/路由/网卡/DNS/hosts/DoH 配置指纹不变（ADRG-0009）
10. **persist 冒烟**（真实客户端）：`cc-fix persist on --region us` → `check` → `persist status` → `persist off` 全闭环；`persistSmoke` 记录 `passed`（CI 上为 `skipped-unsupported`）
11. **界面可用性**：GUI 冷启动无 tofu/方框（自托管字体生效）；axe serious/critical=0（已有 E2E 门禁，真实机上抽查）

## 门禁清零

- [ ] P0 / P1 缺陷清零（保护状态 / 事务 / 地区 / 文档 / 版本漂移）
- [ ] release-blocking P2 清零

## 批准记录（晋级时须记录）

- [ ] 批准人 / 时间
- [ ] 门禁证据（各测试线结果、P0/P1/P2）
- [ ] 已知限制（当前 RC 未签名、npm 渠道状态）

## 晋级触发（仅在全部门禁通过后）

> ⚠️ **产生不可变 stable 发布 / tag，不可覆盖，只能发新版**。确认验收完成后再执行。

```powershell
gh workflow run promote.yml -f rc_tag=v0.2.0-rc.1 -f stable_version=0.2.0 -f publish_npm=<true|false>
```

- `publish_npm=true`：需 npmjs.org 已为 `cc-fix` 配置 Trusted Publishing（OIDC）；未配置则 npm 步骤失败
- `publish_npm=false`（默认）：仅发布 Windows stable，npm 渠道只做 `verify-npm` 完整性校验
- promote 会自动把 `package.json` 升到 stable 版本并打 `vX.Y.Z` tag

## 相关文档

- 流程总览：[release-guide.md](release-guide.md)
- 语义与门禁：[ADR-0010](../adr/0010-windows-release-gates.md)
- 领域术语（发布晋级/不可变发布）：[CONTEXT.md](../CONTEXT.md)
- 生命周期自动化脚本：[scripts/windows/Test-InstallerLifecycle.ps1](../../scripts/windows/Test-InstallerLifecycle.ps1)
