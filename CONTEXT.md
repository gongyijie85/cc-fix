# CC-Fix 上下文

Claude Code 环境安全检测与修复 CLI 工具（Windows 优先）。检测用户环境中可能暴露真实地区/身份的操作系统信号（时区、语言、Locale、字体、DNS、代理、IP 情报等），计算风险评分，并可通过用户级环境变量持久化（`setx`）切换到安全环境。

架构决策记录见 `docs/adr/`。

## 词汇表

| 术语 | 含义 | 避免混用 |
|------|------|----------|
| 检测信号（signal） | 单个检测插件的输出，含 id/label/value/risk/weight/contribution | 不叫"检测项结果" |
| 插件（plugin） | 实现 `DetectionPlugin` 接口的单个检测维度 | 不叫"检测器" |
| 风险评分（score） | 0-100，信号加权归一化后的总分 | 不叫"分数" |
| 持久化（persist） | 通过用户级环境变量（TZ/LANG/LC_ALL）切换环境，`persist on/off` 管理 | 不叫"修复"本身 |
| 修复流（fix flow） | 一次 persist on/off 的步骤化执行过程，以事件流呈现 | |
| 步骤（step） | 修复流中的原子操作：备份 / 设置单键 / 恢复单键 / 删备份 | |
| 事件（event） | 编排层推送的不可变消息，联合类型 `StreamEvent`（见 `src/events/types.ts`） | |
| 阶段（phase） | 非步骤式的耗时过程（如 IP 情报获取） | |
| 汇总（summary） | 修复流的终结事件，含成败计数与 fatal / rolledBack 标志 | |
| 回滚（rollback） | persist on 失败后把已改键恢复为备份值；带 `rollback: true` 标记的步骤 | persist off 不是回滚，是"恢复原始" |
| 常驻通道 | `GET /api/events` 的持久 SSE 连接（EventSource） | |
| 触发端点 | 只启动动作、返回 202/409 的 POST 端点（`/api/fix/on` 等） | |
| 备份（backup） | `%APPDATA%/cc-fix/persist-backup.json`，存最原始的环境变量值，不覆盖 | |
