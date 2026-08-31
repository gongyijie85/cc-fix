# CC-Fix 真实客户端验收记录表

> 对照 `docs/release-acceptance-checklist.md` 执行。请在真实 Windows 客户端填写本表。
> 全部通过 + 门禁清零后，才允许触发 `promote.yml` 晋级 stable。

## 0. 基本信息

| 字段 | 值 |
|---|---|
| 被测安装包 | `CC-Fix-Setup-0.2.0-rc.1-x64.exe` |
| 包 SHA-256 | `830bfe276134b87d1da710a6093127b9fbb2ebea8d2972c65ac4fd5d71856dd7` |
| 构建来源 | 本地构建（含 P0/P1/P1b/P1c 修复，2026-08-31；非 CI 公开发布资产） |
| 验收日期 | ____________ |
| 验收人 | ____________ |
| 操作系统（每线） | 见下表 |

## 1. 主验证线 —— Windows 11 25H2 x64（完整矩阵）

| # | 检查项 | 结果（通过/失败/N/A） | 备注 |
|---|---|---|---|
| 1 | 全新安装：当前用户、无需管理员、落到 `%LOCALAPPDATA%\Programs\CC-Fix` | | |
| 2 | WebView2 缺失时自动安装并复检 | | |
| 3 | 私有运行时 CLI：`runtime\node.exe core\index.js --version` == `0.2.0-rc.1` | | |
| 4 | 桌面单实例：二次启动聚焦已有窗口 | | |
| 5 | sidecar 回收：关闭桌面壳后私有 Node GUI 进程退出 | | |
| 6 | 降级拒绝：安装较旧 SemVer → 拒绝覆盖 | | |
| 7 | 同版本修复：重跑同版修复，不改 `%APPDATA%\cc-fix` | | |
| 8 | 还原优先卸载：先 `persist off`；失败则中止卸载 | | |
| 9 | PATH 精确还原：卸载后 `HKCU\Environment\Path` 与安装前逐字符一致 | | |
| 10 | 网络只读不变量：VPN/路由/网卡/DNS/hosts/DoH 指纹不变 | | |
| 11a | `persist on --region us` → `check` → `persist status` 全闭环（`persistSmoke: passed`） | | |
| 11b | `persist off` → 完整还原日常配置 | | |
| 12 | GUI 冷启动无 tofu/方框（自托管字体生效） | | |
| 13 | axe serious/critical=0（真实机抽查） | | |

## 2. 兼容线 —— Windows 11 24H2 x64（核心子集）

| 检查项 | 结果 | 备注 |
|---|---|---|
| 安装 / 私有运行时 CLI | | |
| 桌面单实例 | | |
| PATH 还原 | | |
| 卸载 | | |

## 3. 新设备线 —— Windows 11 26H1 x64（手工冒烟）

| 检查项 | 结果 | 备注 |
|---|---|---|
| 安装 | | |
| `cc-fix check --region us` | | |
| `persist on/off` 闭环 | | |

## 4. 遗留兼容线 —— Windows 10 22H2 x64

| 检查项 | 结果 | 备注 |
|---|---|---|
| 安装 | | |
| 核心功能（check / persist） | | |

## 5. 门禁清零

- [ ] P0 / P1 缺陷清零（保护状态 / 事务 / 地区 / 文档 / 版本漂移）
- [ ] release-blocking P2 清零
- [ ] 遗留阻塞项：__________________________（若有）

## 6. 验收中发现并修复的缺陷（2026-08-30，真实客户端）

| 级别 | 现象 | 根因 | 修复 | 提交 |
|---|---|---|---|---|
| **P0（阻塞）** | `persist on --level deep --region sg` 失败：`Registry value HKCU\Software\Policies\Microsoft\Edge\DefaultWebRtcIPHandlingPolicy is not REG_SZ` | 真实机该 Edge 策略槽被以 **REG_DWORD 0x4** 存储（非 REG_SZ）；`readRegistryString` 遇非 REG_SZ 硬抛，导致整个 persist 事务失败 | `src/platform/windows/native-backend.ts`：读取改为类型无关（解析任意 `REG_*` 以字符串 best-effort 返回），写路径归一为 REG_SZ；读被拒/缺失视同缺失 | `659dfa9` |
| **P1（展示）** | GUI 历史每条 persist 显示「undefined 成功」（连失败也显示成功） | `renderHistoryRow` 读顶层 `entry.ok/fail/fatal`，但 v2 schema 存 `entry.counts.{ok,fail}` + `entry.outcome` | `assets/gui/app.js`：改按 `outcome`（failed→失败 / compensated→已回滚 / recovery_required→需恢复 / degraded→降级 / noop→无变化 / ok→`counts.ok 成功`）与 `counts` 渲染 | `659dfa9` |
| **P1b（复验新增）** | 复验时 `persist on` 又失败：`Command failed: reg.exe query HKCU\Environment /v LANG` + **GBK 乱码** | 中文系统 `reg.exe` 以 GBK/本地编码输出「系统找不到指定的注册表项或值」，UTF-8 解码后乱码 → `isMissingRegistryError` 文本匹配失效 → 把「键值缺失」误判为致命错误 | `src/platform/windows/native-backend.ts`：改用**退出码判据**（缺失=1、拒绝=5），编码无关，兼容 GBK/UTF-8 | `2f88b01` |
| **P1c（复验收敛）** | 复验后 `persist on` 成功但面板仍报「浏览器策略 6/6 槽位异常（高风险）」+「Windows 区域格式 en-SG 中风险 + 过时的『为中文』建议」 | ① `readPolicyValues` 用 `\n` 切行但 `reg.exe` 输出为 `\r\n`，行尾 `\r` 使正则 `$` 锚失配 → 全部值解析为 null（#75 回归，单测 mock 未带 `\r` 未暴露）；② `win-region` 的 `SAFE_LOCALES` 缺 `en-SG`（sg 目标地区写入的区域）→ 误判中风险并衍生错误建议 | ① `platform/browser.ts` 改用 `split(/\r?\n/)` 切行；② `win-region.ts` `SAFE_LOCALES` 补 `en-SG` 等英文区域 | `a65aed0` |

- [x] 两缺陷已修复（单测 755 + E2E 14 通过），待真实客户端复验
- [x] **开发机复验通过（2026-08-31）**：`persist on deep/sg` → 提交（评分 0）→ `persist off` → 还原日常成功，**on/off 生命周期闭环**；浏览器策略 6/6 就位、区域 en-SG 安全
- [ ] 真实客户端（25H2/24H2/26H1/10 22H2）复验：待安装版执行（原生版须「安装后」运行，persist off 依赖内置 native helper）

> **注意事项（重要）**：`persist off` 的完整生命周期**依赖 native helper**（验证后删日常不可变备份）——仅安装版搭载；
> **开发**布局需在 `dist/../native/`（即仓库根 `native/`，代码内 gitignore）放构建好的 `cc-fix-native-helper.exe` 方可运行 on/off；**正式验收请用已安装的应用**。
> **npm 兼容渠道已解决（2026-08-31）**：发布包 `files` 新增 `native`,prepack 把 cargo 构建的 helper + SHA-256 随包打包（`dist/../native/` 命中）,npm 渠道的 persist on/off 生命周期随之闭环；无 cargo 产物时该渠道 persist off 仍不可用（已知限制）。

## 7. 批准记录（晋级时须记录）

| 字段 | 值 |
|---|---|
| 批准人 | ____________ |
| 时间 | ____________ |
| 门禁证据 | 各测试线结果 / P0-P2 状态 |
| 已知限制 | 未签名（SmartScreen 警告）；npm `latest` 渠道待 OIDC 配置完成 |

## 结论

- [ ] 全部验收通过 → 可触发晋级
- [ ] 存在阻塞项 → 修复后重新验收（不得带病晋级）

## 晋级触发（仅在全部门禁通过后）

```powershell
gh workflow run promote.yml -f rc_tag=v0.2.0-rc.1 -f stable_version=0.2.0 -f publish_npm=<true|false>
```
