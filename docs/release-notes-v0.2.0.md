# CC-Fix v0.2.0 — 发布说明

> 适用：**v0.2.0-rc.2 及后续**。本说明反映「Windows 产品化 v0.2.0」全量能力 + 真实客户端验收期间发现并修复的缺陷集。
> 已发布的 `v0.2.0-rc.1` 为产品化基线,其上不得发布含下述「验收修复集」之外的变更；**携带修复集的正确载体是 `v0.2.0-rc.2`**（ADR-0010）。

## 概述

CC-Fix 首个从「实验性 CLI 收口为可恢复、可审计 Windows 产品」的发布：统一 CLI/桌面 GUI 状态语义，提供日常/标准/深度三态保护、四地区原子切换、崩溃恢复，以及无需预装 Node.js 的单文件离线安装器与可验证发布证据。本版本经真实客户端验收,修复了在该环境暴露的若干 P0/P1 缺陷,并打通 npm 兼容渠道的完整 persist 生命周期。

> ⚠️ **未做 Authenticode 签名**。安装前请核对随包 SHA-256 与 GitHub artifact attestation；Windows SmartScreen 可能显示「未知发布者」警告。

## 主要能力（产品化 v0.2.0）

### 🛡 保护与可恢复
- 三种保护模式：`daily` / `standard` / `deep`；默认从 daily 进入 standard
- `us/eu/jp/sg` 四地区原子切换；非法地区显式失败（不静默回落）
- **耐久事务**：写前计划 → 逐项写入 → 读回验证 → 失败自动补偿 → 完整还原；崩溃后收敛式恢复
- 首次离开日常保存**不可变日常快照**；关闭保护时读回验证并完整还原；`recovery_required` 显式表达

### 🌐 网络只读
- VPN / 路由器 / 路由表 / 网卡 / DNS / hosts / DoH **只检测、解释、提醒**,绝不修改（ADR-0009）

### 🖥️ 多端
- CLI、桌面应用（Tauri v2 / WebView2）、本地 GUI 共用同一核心与状态语义；本地 GUI 经会话认证（一次性 token + HttpOnly Cookie + Host/Origin/loopback 校验,SSE）

### 📦 发布
- 无需预装 Node.js 的当前用户单文件离线安装器（内置 Node 24 私有运行时 + WebView2 离线组件）
- 发布证据：SHA-256 / CycloneDX SBOM / 第三方声明 / 构建信息 / artifact attestation / Windows 生命周期测试

## 验收修复集（已发布 rc.1 之后的增量,承载于 rc.2）

> 以下缺陷来自**真实客户端验收**,均已在开发机 + 安装版复验通过。已发布 rc.1 含以下未修复项,故正确载体为 rc.2。

### 🔴 P0 — persist 遇非 REG_SZ 策略值硬抛
- **现象**：真实机上 Edge `DefaultWebRtcIPHandlingPolicy` 被以 `REG_DWORD 0x4` 存储,persist on 报 `... is not REG_SZ` 并失败（整体事务中止）
- **修复**：`src/platform/windows/native-backend.ts` 读取改为**类型无关**（解析任意 `REG_*` 以字符串 best-effort 返回）,写路径归一为期望 REG_SZ；读被拒/缺失视同缺失
- `659dfa9`

### 🟠 P1 — GUI 历史「undefined 成功」
- **现象**：历史每条 persist 显示「undefined 成功」（连失败也显示成功）
- **修复**：`assets/gui/app.js` 渲染改按 v2 schema 的 `outcome`/`counts`（failed→失败 / compensated→已回滚 / recovery_required→需恢复 / degraded→降级 / noop→无变化 / ok→`counts.ok 成功`）
- `659dfa9`

### 🟠 P1b — GBK 乱码下 persist 误判失败
- **现象**：中文系统 `reg.exe` 以 GBK/本地编码输出「系统找不到指定的注册表项或值」,UTF-8 解码后乱码,`isMissingRegistryError` 文本匹配失效 → 把「键值缺失」误判为致命错误
- **修复**：`native-backend.ts` 改用**退出码判据**（缺失=1、拒绝=5）,编码无关（GBK/UTF-8 皆稳）
- `2f88b01`

### 🟠 P1c — 浏览器策略检测回归 + 区域误判
- **现象**：persist 成功后检测仍报「浏览器策略 6/6 槽位异常（高风险）」+「Windows 区域格式 en-SG 中风险 + 过时『为中文』建议」
- **修复**：① `src/platform/browser.ts` 用 `split(/\r?\n/)` 切行（`reg.exe` 输出为 CRLF,行尾 `\r` 使 `$` 锚失配 → 全部值解析为 null,#75 回归）;② `src/detection/plugins/win-region.ts` 安全语言表补 `en-SG` 等英文区域
- `a65aed0`

### 🟢 npm 兼容渠道 persist 生命周期
- **现象**：npm 渠道（不含 Windows 原生 helper）persist off 报「Verified native backup deletion is unavailable」
- **修复**：发布包 `files` 新增 `native`,prepack 把 cargo 构建的 helper + SHA-256 随包打包 → `dist/../native/` 命中 → npm 渠道 on/off 生命周期闭环
- `225fb25`

## 验证

- 单测 **758 用例全过**（含上述缺陷的回归用例）· Playwright E2E **14 过** · Rust 测试（native-helper 3 + src-tauri 9）过
- 真实客户端复验：`persist on deep/sg` → 提交 → `persist off` → 还原 → **生命周期闭环**;检测评分 0（浏览器策略 6/6 就位、区域 en-SG 安全）
- 发布验证：`verify-npm` OK（tarball 含 native）· 载荷门禁 · 证据包（SBOM/THIRD-PARTY/attestation）

## 已知限制

- **未签名**（SmartScreen 可能警告;发布者验证需核对 SHA-256）。
- `persistSmoke` 在 CI runner 恒跳过（缺 `Get-WinUserLanguageList`）;完整验证需真实客户端（ADR-0010）。
- npm `latest` 发布待 `promote.yml` 配置 npm OIDC Trusted Publishing 后启用。
- 真实客户端验收矩阵（25H2/24H2/26H1/10 22H2）待执行完毕后,方可晋级 stable。

## 参考

- 规格：`docs/spec/windows-productization-v0.2.md` · ADR 0004–0014
- 域名词汇：`CONTEXT.md`
- 真实客户端验收手册 / 记录：`docs/release-acceptance-checklist.md` / `docs/release-acceptance-record.md`
- 发布流程：`docs/release-guide.md`
