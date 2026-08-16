# 同类开源竞品调研(2026-08-15)

> 数据来源:GitHub API(`api.github.com/repos/*` 与 `/commits`,2026-08-15 实测)+ 各仓库 README。
> 目的:Q9 借鉴清单的落档。结论:cc-fix 的"系统级修复+耐久事务+备份还原+桌面壳+安装器"组合在调研范围内唯一;借鉴项不排期,0.2.0 发布后进 backlog。

## 对比明细

| 项目 | Stars | 活跃度 | License | 核心功能 | 检测维度 | 写操作 | Windows 系统级 | 技术栈 | 借鉴点 |
|---|---|---|---|---|---|---|---|---|---|
| [yacuo/check-cc](https://github.com/yacuo/check-cc) | 445 | ✅ 活跃 | MIT | 40+ 环境检测聚合为账号风险画像 | 语言/时区/Intl/UA/容器/信号一致性/IP 纯净度 | ❌ 纯检测(内测一键修复+三端桌面端) | ❌ 尚无 | Next.js/React/TS | 信号一致性校验、风险画像话术、隐私声明 |
| [yurukusa/cc-health-check](https://github.com/yurukusa/cc-health-check) | 0 | ⛔ 归档 | MIT | 20 项×6 维度评分 0-100 | settings/CLAUDE.md 配置健康 | ❌ 只诊断 | ❌ | CLI 零依赖 | 评分/badge/CI exit-code 模式 |
| [gabrielsoltz/clauditor](https://github.com/gabrielsoltz/clauditor) | 45 | ✅ 活跃 | Apache-2.0 | 50+ 安全检查,四级作用域+远程 git 扫描 | 权限/hook/凭据/供应链 | ✅ generate 加固配置 | ❌ | Python | YAML 可扩展检查、报告即教育、--base-level/--exit-code |
| [gobeyondidentity/claude-defense-kit](https://github.com/gobeyondidentity/claude-defense-kit) | 9 | ⛔ 归档 | ⚠️ 无 | 爆炸半径视角:安装完整性/MCP 风险/凭据暴露面 | 凭据/能力分析 | ✅ 一键修复+Undo | ❌ | TS/Node 本地 Web | 一键修复+Undo→升级为事务级回滚;凭据暴露面清单 |
| [dwarvesf/claude-guardrails](https://github.com/dwarvesf/claude-guardrails) | 31 | ✅ 活跃 | MIT | Lite/Full 两档加固配置 | deny 规则/hooks/密钥扫描 | ✅ 先备份再合并+外科手术式卸载 | ❌ | Shell/npx | Lite/Full 分档、只增删自己条目的卸载 |
| [openrec0n/agent-armor](https://github.com/openrec0n/agent-armor) | 0 | ⚠️ 一般 | MIT | 8 类威胁×4 档 profile 生成器 | 威胁建模引用真实 CVE | ✅ 生成/导出 | ❌ | TS 纯前端+核心库 | 威胁清单+profile UX、merge 不丢自定义 |
| [gokuscraper/claude-tester](https://github.com/gokuscraper/claude-tester) | 89 | ⚠️ 一般 | MIT | 模拟 Claude 判定中国用户:加权 0-100 | 时区/语言/字体/Intl/偏移/Emoji | ❌ 纯检测 | ❌ | Vite+TS 纯前端 | 权重透明可解释的加权评分 |
| [xiaohonghua661/claude-env-check](https://github.com/xiaohonghua661/claude-env-check) | 1 | ✅ 活跃 | ⚠️ 无 | 一键切换 英文+纽约⇄中文+北京 | 系统区域/时区/Chrome 策略/输入法/时间戳报告 | ✅ Windows 系统级 | ✅ **唯一直接重叠** | 单文件 Batchfile | UAC 权限分级(检测免管理员/修复才提权)、保留输入法 |
| [jason5ng32/MyIP](https://github.com/jason5ng32/MyIP) | 11,589 | ✅ 非常活跃 | MIT | IP 工具箱:PWA/多源对比 | WebRTC/DNS leak/IP 质量/258 项清单 | ❌ 纯工具箱 | ❌ | Node+Docker+PWA | WebRTC/DNS leak 成熟实现、多 IP 库对比 |

## 结论

### 1) 直接竞争
- **最直接**:claude-env-check(1★)— 唯一已实现 Windows 系统级修改+一键伪装切换的竞品,但无事务/备份还原/桌面壳/安装器/许可证,单文件 bat,工程化弱。
- **最大威胁**:check-cc(445★)— 检测维度最全、star 最高,已宣布内测"一键修复+三端桌面端",即将进入 cc-fix 的修复+桌面壳领地。
- **间接竞争(配置层)**:clauditor / claude-guardrails / agent-armor / claude-defense-kit 只做 `~/.claude/settings.json` 加固修复,非系统级。

### 2) cc-fix 独特卖点
**成立,缺口明确。** 9 个对象中做 Windows 系统级修改的仅 claude-env-check 一家,且它不具备耐久事务/原子回滚、备份-还原体系、Tauri 桌面壳、Inno 安装器中任何一项;没有竞品提供"修复即事务、失败可回滚"的保证。cc-fix 的组合在调研范围内唯一。风险:check-cc 桌面修复一旦发布会抢占"检测→修复"心智,cc-fix 须以工程深度(事务安全、可回滚、分发、报告质量)差异化,而非功能清单。

### 3) 最值得借鉴的 5 项(0.3 backlog 候选)
1. **check-cc 信号一致性校验**:语言 vs 时区 vs IP vs 容器交叉校验,检测矛盾而非单点(检测侧已有 consistency 插件雏形,可扩展)。
2. **clauditor 可扩展检查体系**:YAML 定义 check、攻击场景+修复步骤文档化、`--base-level` 强制基线、`--exit-code` 进 CI(T13 已落地稳定退出码,可直接接)。
3. **claude-defense-kit 一键修复+Undo**:升级为 cc-fix 事务级回滚(事务引擎已具备,缺的是暴露面);凭据暴露面/MCP 风险分级清单。
4. **claude-guardrails 外科手术式卸载 + Lite/Full 分档**:只增删自己管理的条目、按信任场景分档,比整文件备份恢复更稳健。
5. **MyIP WebRTC/DNS leak 检测实现 + claude-tester 加权评分模型**(权重透明、可解释)+ cc-health-check 评分/badge/CI 集成模式。

### 4) 盯梢清单
- **claude-env-check**(2026-07-31 创建,1★,活跃)— 唯一直接做 Windows 系统级伪装+修复的竞品,迭代快。
- **claude-tester**(2026-07-03,89★)— 纯前端检测,star 增长快,验证检测需求传播力。
- **check-cc 桌面修复程序 release 动态**(内测中)— 最大潜在正面竞争对手。
- 已归档项目(cc-health-check、claude-defense-kit)无维护价值,思路可借鉴;⚠️ claude-defense-kit 与 claude-env-check **无 LICENSE 文件**,只借鉴思路不抄实现。

## 来源
- https://github.com/yacuo/check-cc | https://github.com/yurukusa/cc-health-check | https://github.com/gabrielsoltz/clauditor | https://github.com/gobeyondidentity/claude-defense-kit | https://github.com/dwarvesf/claude-guardrails | https://github.com/openrec0n/agent-armor | https://github.com/gokuscraper/claude-tester | https://github.com/xiaohonghua661/claude-env-check | https://github.com/jason5ng32/MyIP
