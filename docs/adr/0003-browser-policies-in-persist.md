# 浏览器加固通过原生策略注册表（HKCU）实现，纳入 persist 生命周期

checkcc.org 复测显示环境变量 + 系统时区全部修复后，浏览器侧中文画像与 WebRTC 泄漏仍占可观风险分。扩展修复边界到浏览器层，但维持既有"用户级、不碰个人数据"约束（ADR-0001 的在 cc-fix 上演进、单一事实源原则不变）。浏览器加固的载体有三选：浏览器扩展、直接改浏览器 Preferences 配置文件、原生企业策略注册表项。决定采用第三种，写入 HKCU（无需管理员权限，与 setx/tzutil 同级）：persist on 时向 Chrome/Edge 写入 `AcceptLanguage`（跟随目标地区，如 us→en-US、jp→ja-JP、sg→en-SG、eu→en-GB）与 WebRTC 防泄漏策略（`DefaultWebRtcIPHandlingPolicy=disable_non_proxied_udp`）；写入前把原值（含"不存在"）记入备份快照的新字段 `previousBrowserPolicies`，persist off 精确还原——与单一快照"保留最原始值"语义完全一致。策略需重启浏览器生效，GUI 只做提示不强制杀进程。系统语言列表（`navigator.languages` 的根源）暂不改动——若复测后 Intl 信号仍在，再经用户确认升级到系统语言层。

## Considered Options

- **浏览器扩展**：被否。引入额外安装/维护步骤，扩展本身成为新的指纹特征，与"一键全管"目标冲突。
- **改浏览器 Preferences 文件**：被否。浏览器运行时写入会被退出时覆盖，文件格式随版本演进不可控。
- **原生策略注册表（HKCU）**：采纳。浏览器官方支持通道、优先级最高，备份/还原语义可直接复用现有快照机制。

## 实施修正（2026-08）

原假设"HKCU 无需管理员权限"在 ACL 加固的机器上不成立：实测发现 `HKCU\Software\Policies` 可对普通用户只读（FullControl 仅 SYSTEM/Administrators 组），未提升进程写入被拒。因此修复流对策略步骤采用**权限感知降级**：写入被拒（Access is denied）时该步骤标记失败并提示以管理员权限重试，但不回滚环境变量与系统时区、不阻断流程；persist off 只还原当前值与快照不一致的槽位，降级状态下（策略从未写入）自动跳过，不产生无意义写入。
