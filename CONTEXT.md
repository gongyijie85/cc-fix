# CC-Fix 上下文

Claude Code 环境安全检测与修复 CLI 工具（Windows 优先）。检测用户环境中可能暴露真实地区/身份的操作系统信号（时区、语言、Locale、字体、DNS、代理、IP 情报等），计算风险评分，并可通过用户级环境变量持久化（`setx`）切换到安全环境。

架构决策记录见 `docs/adr/`。

## 词汇表

| 术语 | 含义 | 避免混用 |
|------|------|----------|
| 检测信号（signal） | 单个检测插件的输出，含 id/label/value/risk/weight/contribution | 不叫"检测项结果" |
| 插件（plugin） | 实现 `DetectionPlugin` 接口的单个检测维度 | 不叫"检测器" |
| 风险评分（score） | 0-100，信号加权归一化后的总分 | 不叫"分数" |
| 持久化（persist） | 通过用户级环境变量（TZ/LANG/LC_ALL）+ 系统时区（tzutil）切换环境，`persist on/off` 管理 | 不叫"修复"本身 |
| 修复流（fix flow） | 一次 persist on/off 的步骤化执行过程，以事件流呈现 | |
| 步骤（step） | 修复流中的原子操作：备份 / 设置单键 / 切换系统时区 / 恢复单键 / 恢复系统时区 / 删备份 | |
| 事件（event） | 编排层推送的不可变消息，联合类型 `StreamEvent`（见 `src/events/types.ts`） | |
| 阶段（phase） | 非步骤式的耗时过程（如 IP 情报获取） | |
| 汇总（summary） | 修复流的终结事件，含成败计数与 fatal / rolledBack 标志 | |
| 回滚（rollback） | persist on 失败后把已改键恢复为备份值；带 `rollback: true` 标记的步骤 | persist off 不是回滚，是"恢复原始" |
| 一键切换 | GUI 中对 persist on 的用户化称呼：切换到目标地区安全环境 | 不是独立于 persist 的新概念 |
| 一键还原日常配置 | GUI 中对 persist off 的用户化称呼：按备份恢复环境变量与系统时区 | 不是"撤销"，备份删除后不可重复还原 |
| 常驻通道 | `GET /api/events` 的持久 SSE 连接（EventSource） | |
| 触发端点 | 只启动动作、返回 202/409 的 POST 端点（`/api/fix/on` 等） | |
| 备份（backup） | `%APPDATA%/cc-fix/persist-backup.json`，存最原始的环境变量值与系统时区（`previousSystemTimezone`，旧版备份可能缺失），不覆盖 | |
| 操作日志（history） | `%APPDATA%/cc-fix/history.jsonl` 追加式记录每次 on/off/check，回答"我上次干了什么" | 与备份分工：快照负责可恢复，日志负责可追溯（ADR-0002） |
| 目标地区（target region） | us/eu/jp/sg 四档，`TARGET_REGIONS` 为 CLI 与 GUI 的同一事实源，非法值回落 us | GUI 下拉框选择不记忆 |

## 统一事件协议

修复流与检测流共用同一联合类型 `StreamEvent = FixEvent | DetectEvent`（定义于 `src/events/types.ts`），编排层以回调推送事件，消费方（终端渲染 / GUI 服务端）自行决定呈现方式。

- **GUI 传输模型**：浏览器维护一条 `GET /api/events` 的 SSE 常驻通道接收全部事件；`POST /api/fix/on`、`/api/fix/off`、`/api/check/start` 为触发端点，只启动动作并立即返回 `202`（全局忙时返回 `409`），不等待结果——因此不存在同步阻塞式端点
- **修复流事件**：`step-start`（携带旧→新值）→ `step-ok` / `step-fail` → `summary`（终结事件）；失败触发的回滚步骤带 `rollback: true`
- **检测流事件**：`phase`（如 IP 情报获取中）→ `detect-start` → 逐个 `detect-ok` → `detect-done`（含最终评分）
- **recheck**：修复成功后前端自动触发复测，服务端对比修复前后评分并推送 `{ type: "recheck", before, after }`
