## ✅ 决议

实施规格已汇总至 `.wayfinder/research/phase3-implementation-spec.md`（410 行），覆盖：

1. **统一事件层**（`src/events/types.ts`）：`FixEvent` / `DetectEvent` / `StreamEvent` 联合类型，`EventConsumer` 回调签名
2. **编排层**（`src/fix/flow.ts`）：`persistOnFlow` / `persistOffFlow` / `rollbackFlow` 内部辅助，`runDetection` 加可选 `onEvent` 参数
3. **SSE 端点**（`src/gui/server.ts`）：常驻通道 `GET /api/events` + 触发端点（202/409），删除旧同步端点
4. **前端渲染**（`src/gui/index.html`）：变体 B（步骤清单卡片），EventSource 驱动，自动复测
5. **CLI 消费**（`src/index.ts`）：chalk 逐行打印，不自动复测
6. **测试要点**：事件 schema、编排层、SSE 端点、CLI 输出

**实施顺序**：类型定义 → 编排层 → runner 改造 → server 改造 → 前端改造 → CLI 改造 → 测试。

本规格决策完备，可直接交棒实施。
