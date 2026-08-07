# 浏览器加固通过原生策略注册表（HKCU）实现，纳入 persist 生命周期

checkcc.org 复测显示环境变量 + 系统时区全部修复后，浏览器侧中文画像与 WebRTC 泄漏仍占可观风险分。扩展修复边界到浏览器层，但维持既有"用户级、不碰个人数据"约束（ADR-0001 的在 cc-fix 上演进、单一事实源原则不变）。浏览器加固的载体有三选：浏览器扩展、直接改浏览器 Preferences 配置文件、原生企业策略注册表项。决定采用第三种，写入 HKCU（无需管理员权限，与 setx/tzutil 同级）：persist on 时向 Chrome/Edge 写入 `AcceptLanguage`（跟随目标地区，如 us→en-US、jp→ja-JP、sg→en-SG、eu→en-GB）与 WebRTC 防泄漏策略（`DefaultWebRtcIPHandlingPolicy=disable_non_proxied_udp`）；写入前把原值（含"不存在"）记入备份快照的新字段 `previousBrowserPolicies`，persist off 精确还原——与单一快照"保留最原始值"语义完全一致。策略需重启浏览器生效，GUI 只做提示不强制杀进程。系统语言列表（`navigator.languages` 的根源）暂不改动——若复测后 Intl 信号仍在，再经用户确认升级到系统语言层。

## Considered Options

- **浏览器扩展**：被否。引入额外安装/维护步骤，扩展本身成为新的指纹特征，与"一键全管"目标冲突。
- **改浏览器 Preferences 文件**：被否。浏览器运行时写入会被退出时覆盖，文件格式随版本演进不可控。
- **原生策略注册表（HKCU）**：采纳。浏览器官方支持通道、优先级最高、用户级权限即可写入，备份/还原语义可直接复用现有快照机制。
