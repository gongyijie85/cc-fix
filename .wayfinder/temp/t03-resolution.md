## ✅ 决议

两轮 grilling 共 9 项决策，全部确认。

### 1. 事件 schema — 可辨识联合，无时间戳（Q1/Q6）

新模块 `src/events/types.ts`：

```ts
export type FixEvent =
  | { type: "step-start"; stepId: string; name: string; oldValue?: string; newValue?: string; rollback?: boolean }
  | { type: "step-ok";    stepId: string; rollback?: boolean }
  | { type: "step-fail";  stepId: string; error: string; rollback?: boolean }
  | { type: "summary";    ok: number; fail: number; rolledBack: boolean; fatal?: boolean }
  | { type: "recheck";    before: number; after: number };

export type DetectEvent =
  | { type: "phase";       label: string }            // 如"正在获取 IP 情报…"
  | { type: "detect-start" }
  | { type: "detect-ok";   signal: SignalResult }     // 携带完整信号，前端按 id 填占位行
  | { type: "detect-done"; response: CheckResponse }; // 携带完整结果，前端渲染逻辑与今天一致

export type StreamEvent = FixEvent | DetectEvent;
```

- 扩展方式 = 新增事件种类（未来自动修复动作加新 type），不预留字段、不加时间戳
- 回滚步骤复用 `step-*` 种类 + `rollback: true` 标记，不新增种类
- 检测占位行共 **12 行**：10 插件 + 2 个 IP 派生信号（`ip-datacenter`/`ip-multi-source`），按 signal id 填充

### 2. SSE 端点 — 常驻通道 + POST 触发（Q2/Q7）

- 页面加载即打开 `GET /api/events`（原生 EventSource，自动重连）
- 触发端点：`POST /api/fix/on`、`POST /api/fix/off`、`POST /api/check/start` —— 只触发动作，返回 202 或 409
- **删除**旧同步端点 `GET /api/check`、`POST /api/persist/on|off`（被流式通道完全取代，避免双路径）
- 浏览器断连**不中断**修复：服务端执行到底（成功或回滚）；重连后不回放事件，状态栏用 `/api/status` 重建

### 3. 回滚语义（Q3/Q8）

- **persist on**：任一步失败 → 中止后续 → 只回滚**本次已成功修改过的键**（从备份 `previous` 恢复，原值为 null 则删除该变量）→ 回滚步骤带 `rollback: true` 进流 → `summary` 标 `rolledBack: true`
- **回滚自身失败**：发 `step-fail`（rollback 步骤）+ `summary` 带 `fatal: true`；不重试，前端展示"需手动检查 HKCU\Environment"红色告警
- **persist off 无回滚**：步骤 = 逐键恢复（带旧→新值）+ 删除备份文件；失败即中止并 `summary` 标 `fatal: true`（"恢复原始"无反操作）

### 4. 服务端锁 — 单把全局锁（Q4）

fix on / fix off / check 任一进行中，其余触发端点一律 `409 { error }`。修复不因断连中断，执行完（含回滚）才释放锁。前端按钮禁用是体验，锁是双标签页兜底。

### 5. 编排层与 CLI 消费 — 回调参数（Q5/Q9）

- 新模块 `src/fix/flow.ts` 导出 `persistOnFlow(opts, onEvent)` / `persistOffFlow(opts, onEvent)`；`runDetection` 加可选 `onEvent` 参数（推 phase/detect-start/detect-ok），返回值不变
- `server.ts` 与 `index.ts` 均改调编排层，**删除两处重复的 persist 拼装逻辑**
- CLI 每事件一行 chalk 打印：`✓ TZ: (未设置) → America/Los_Angeles`；结束打汇总行
- CLI **不自动复测**（保持轻快），提示"运行 `cc-fix check` 验证效果"；GUI 的自动复测（决策 12）只在面板场景

### 术语表（本票定名）

| 术语 | 含义 |
|------|------|
| 步骤（step） | 修复流程中的一个原子操作（备份/设置单键/恢复单键/删备份） |
| 事件（event） | 编排层向消费者推送的不可变消息，联合类型 `StreamEvent` |
| 阶段（phase） | 非步骤式的耗时过程（如 IP 情报获取） |
| 汇总（summary） | 一次修复流的终结事件，携带成败计数与 fatal/rolledBack 标志 |
| 常驻通道 | `GET /api/events` 的持久 SSE 连接 |
| 触发端点 | 只启动动作不返回数据的 POST 端点 |
