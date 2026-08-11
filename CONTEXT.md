# CC-Fix 上下文

Claude Code 环境安全检测与修复 CLI 工具（Windows 优先）。检测用户环境中可能暴露真实地区/身份的操作系统信号（时区、语言、Locale、字体、DNS、代理、IP 情报等），计算风险评分，并可通过用户级环境变量持久化（`setx`）切换到安全环境。

架构决策记录见 `docs/adr/`。

## 词汇表

| 术语 | 含义 | 避免混用 |
|------|------|----------|
| 检测信号（signal） | 单个检测插件的输出，含 id/label/value/risk/weight/contribution | 不叫"检测项结果" |
| 插件（plugin） | 实现 `DetectionPlugin` 接口的单个检测维度 | 不叫"检测器" |
| 风险评分（score） | 0-100，信号加权归一化后的总分 | 不叫"分数" |
| 持久化（persist） | 管理日常状态、标准保护和深度保护之间的可还原切换 | 不叫"修复"本身 |
| 修复流（fix flow） | 一次 persist on/off 的步骤化执行过程，以事件流呈现 | |
| 步骤（step） | 修复事务中的单项可验证操作；写入前记录意图，写入后从权威存储读回验证 | 不把命令返回成功等同于步骤成功 |
| 事件（event） | 编排层推送的不可变消息，联合类型 `StreamEvent`（见 `src/events/types.ts`） | |
| 阶段（phase） | 非步骤式的耗时过程（如 IP 情报获取） | |
| 汇总（summary） | 修复流的终结事件，含成败计数与 fatal / rolledBack 标志 | |
| 回滚（rollback） | persist on 失败后把已改键恢复为备份值；带 `rollback: true` 标记的步骤 | persist off 不是回滚，是"恢复原始" |
| 日常状态（daily） | 未启用保护时的用户原始环境状态 | 不叫"关闭模式"或"未修复" |
| 一键切换 | GUI 中对 persist on 的用户化称呼：默认进入目标地区的标准保护 | 不是独立于 persist 的新概念 |
| 一键还原日常配置 | GUI 中对 persist off 的用户化称呼：按备份恢复原始日常环境 | 不是"撤销"，备份删除后不可重复还原 |
| 标准保护（standard protection） | 默认的安全环境强度；以低干扰方式对齐核心信号，并保留用户日常语言与区域偏好 | 不叫"基础修复"或"普通模式" |
| 深度保护（deep protection） | 用户明确选择的增强安全环境强度；进一步对齐语言与区域画像，并承诺可完整还原 | 不叫"强制修复"或"彻底清理" |
| 保护模式（protection mode） | 最后一次完整成功提交的日常、标准保护或深度保护状态 | 不用备份是否存在推断模式；不表示尚未成功的目标状态 |
| 保护健康状态（protection health） | 当前环境与所选保护强度的对齐程度，分为正常、降级和需恢复；它独立于日常/标准/深度模式 | 不把部分失败称为新的保护模式 |
| 常驻通道 | `GET /api/events` 的持久 SSE 连接（EventSource） | |
| 触发端点 | 只启动动作、返回 202/409 的 POST 端点（`/api/fix/on` 等） | |
| 备份（backup） | 首次离开日常状态时保存的原始环境快照；跨重复开启和保护强度切换复用且不覆盖，完整还原后删除 | 不叫"恢复点"或"历史版本" |
| 操作日志（history） | 追加记录每次检测与保护状态转换的请求、结果和最终状态，回答"我上次干了什么" | 与备份分工：快照负责可恢复，日志负责可追溯（ADR-0002） |
| 地区目录（region catalog） | 产品支持的有效地区画像集合，当前为 us/eu/jp/sg | 不叫"地区状态"；非法值不属于目录 |
| 偏好地区（preferred region） | 日常状态下用户最后选择并希望后续使用的地区，首次使用默认为 us | 不叫"生效地区" |
| 生效地区（active region） | 最后一次保护状态转换完整成功后实际提交的地区 | 不叫"所选地区"；失败请求不改变它 |
| 目标地区（target region） | 某次检测、保护转换或临时运行经规则解析后使用的地区 | 不与偏好地区或生效地区混用 |
| 外部网络配置（external network configuration） | VPN 客户端与隧道、网络适配器、系统/上游 DNS、路由表及路由器配置；CC-Fix 只检测、解释和提醒 | 不自动写入、切换、重启或调用第三方管理接口；不得把网络建议包装成一键修复 |
| 保护目标（protection target） | 一次完整成功提交的保护强度与生效地区组合 | 不分别提交强度和地区；失败请求不是保护目标 |
| 修复事务（persist transaction） | 一次保护目标转换或完整还原的耐久编排；先记录计划，再逐项写入、验证、提交或补偿 | 不把备份文件存在视为事务已提交 |
| 事务日志（transaction journal） | 当前修复事务的可恢复进度，含事务 ID、旧/新目标、逐项原值/目标值和执行/验证状态 | 不等同于追加式操作日志；事务结束后可清理 |
| 完整还原（complete restore） | 原始快照中的每一项（包括不存在、null 和空列表）均已恢复并读回验证，之后才提交日常状态 | 不把部分恢复或命令成功称为完整还原 |
| 收敛式恢复（convergent restore） | persist off 或中断恢复持续向原始日常状态推进；已还原项不反向改回保护态，失败项保留供重试 | 不等同于 persist on 失败后的逆序回滚 |
| 桌面壳（desktop shell） | 承载 CC-Fix 主窗口并管理单实例、本地 GUI 服务、退出与恢复入口的轻量宿主 | 不承载检测或修复领域逻辑；不叫“桌面版核心” |
| 本地 GUI 服务（local GUI service） | 桌面会话期间由私有 Node 运行时启动、仅监听回环地址并提供现有 HTML/HTTP/SSE 的进程 | 不把随机端口当作安全边界；不作为长期后台服务 |
| 桌面会话（desktop session） | 一次桌面壳生命周期及其高熵认证令牌、本地 GUI 服务和窗口的组合 | 不跨应用重启复用认证令牌 |
| 特权助手（privileged helper） | 经用户确认后短时提升、只接受有限且已验证的策略写入请求、完成即退出的进程 | 不接受任意命令或脚本；不提升整个 GUI |
| 诊断日志（diagnostic log） | 桌面壳与本地服务的脱敏、滚动技术日志，用于排查启动和运行故障 | 不等同于操作历史；不记录环境变量值、IP 等敏感数据 |
| 受管程序文件（managed application files） | 安装器拥有并可在升级、修复或卸载时替换/删除的桌面壳、私有运行时、核心 bundle、CLI 启动器、许可证和快捷方式 | 不包含 `%APPDATA%\cc-fix` 中的用户状态 |
| 恢复数据（recovery data） | 完整还原所必需的原始备份、状态元数据和未完成事务日志 | 不等同于诊断日志或普通偏好；非日常状态下不得删除 |
| 程序卸载（application uninstall） | 删除受管程序文件、快捷方式、卸载注册和 CC-Fix 自有 PATH 段 | 不等同于完整还原；卸载程序不代表系统设置已恢复日常状态 |
| 修复安装（repair install） | 使用同版本安装包重新验证并覆盖受管程序文件及所选集成项 | 不修改恢复数据、保护目标、偏好或操作历史 |
| 保留状态重装（state-preserving reinstall） | 卸载程序但保留用户状态后再次安装；首次启动先校验并接续已有保护/恢复状态 | 不当作全新安装，不创建或覆盖原始备份 |
| 发布候选版（release candidate / RC） | 使用 `X.Y.Z-rc.N` 版本、已通过自动发布门禁并供公开验收的候选资产 | 不叫开发包或正式版；失败后递增 N，不替换同名资产 |
| 正式公开版（stable release） | 使用 `X.Y.Z` 版本、通过全部自动门禁和一次人工批准后公开的稳定资产 | 不把 CI 成功或草稿 Release 等同于正式发布 |
| 公开发布资产（public release artifact） | 从干净版本 tag 的受控 CI 构建、可追溯到同一源码提交的 Windows EXE、npm CLI 包及其校验/清单 | 本地开发构建不能作为公开资产；不同渠道不得同版本异源码 |
| 发布门禁（release gate） | 决定候选资产能否进入草稿 RC 或正式公开版的一组可复核自动检查与人工批准 | 不把单元测试通过等同于可发布；正式版必须有人批准 |
| 主测试线（primary test line） | 每个 RC 与正式版都必须完整执行安装生命周期矩阵的首要 Windows 客户端版本，当前为 Windows 11 25H2 x64 | 不用 Windows Server runner 代替客户端验收 |
| 兼容测试线（compatibility test line） | 正式支持且必须执行规定兼容验收的其他 Windows 客户端版本，当前含 Windows 11 24H2 x64；26H1 x64至少执行正式版人工冒烟 | 不等同于主测试线的完整矩阵 |
| 遗留兼容线（legacy compatibility line） | 上游已结束常规支持但产品仍验证安装与核心功能的系统，当前为 Windows 10 22H2 x64 | 不宣称操作系统仍受 Microsoft 常规支持，也不承诺修复上游安全问题 |
| 发布证据包（release evidence bundle） | 与安装包同版本同提交发布的 SHA-256、CycloneDX SBOM、第三方声明、构建信息和来源证明 | 不把单一校验和或 CI 日志称为完整发布证据 |
| 可重复载荷（reproducible payload） | 固定源码、锁文件和工具链在独立干净构建中产生的相同未签名核心 bundle、私有运行时文件清单、依赖锁摘要与 SBOM | 不要求含构建时间戳和 Authenticode 时间戳的最终安装包逐字节相同 |
| 不可变发布（immutable release） | tag、版本号和公开资产发布后不可移动、覆盖或以不同内容重发；修正必须使用新版本 | 不把替换同名 EXE 或重新计算同版本校验和称为修复发布 |
| 发布晋级（release promotion） | 最后一个通过全部门禁的 RC 只变更允许的版本元数据与发布说明后成为正式公开版 | RC 后任何代码、依赖或安装器变化都必须产生新的 RC |
| 浏览器策略（browser policy） | Chrome/Edge 原生策略注册表项（HKCU\Software\Policies\…）：`AcceptLanguage`（跟随目标地区）与 WebRTC 防泄漏策略，persist on 写入、off 还原 | 不叫"浏览器插件"；不改系统语言列表（ADR-0003） |
| 策略快照 | 备份快照中的 `previousBrowserPolicies`：写策略前的原值，含"不存在"（还原时删除） | 与备份同源同一文件，同一"保留最原始值"语义 |

## 统一事件协议

修复流与检测流共用同一联合类型 `StreamEvent = FixEvent | DetectEvent`（定义于 `src/events/types.ts`），编排层以回调推送事件，消费方（终端渲染 / GUI 服务端）自行决定呈现方式。

- **GUI 传输模型**：浏览器维护一条 `GET /api/events` 的 SSE 常驻通道接收全部事件；`POST /api/fix/on`、`/api/fix/off`、`/api/check/start` 为触发端点，只启动动作并立即返回 `202`（全局忙时返回 `409`），不等待结果——因此不存在同步阻塞式端点
- **修复流事件**：`step-start`（携带旧→新值）→ `step-ok` / `step-fail` → `summary`（终结事件）；失败触发的回滚步骤带 `rollback: true`
- **检测流事件**：`phase`（如 IP 情报获取中）→ `detect-start` → 逐个 `detect-ok` → `detect-done`（含最终评分）
- **recheck**：修复成功后前端自动触发复测，服务端对比修复前后评分并推送 `{ type: "recheck", before, after }`
