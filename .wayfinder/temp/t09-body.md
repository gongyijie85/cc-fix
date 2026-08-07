## Question

把已锁定的方向（地图 Notes 决策 5/6/7/9/11）细化为可实施的协议决策，用 /grilling + /domain-modeling 逐项敲定：

1. **事件 schema**：统一事件层的 TypeScript 类型——事件种类（步骤开始/成功/失败、阶段、汇总、回滚步骤）、字段（步骤 id、名称、状态、oldValue/newValue、错误信息、时间戳），需为未来自动修复动作预留扩展（见地图 Not yet specified）
2. **SSE 端点形态**：修复如何触发并订阅流？（如 `POST /api/fix/on` 直接以 SSE 响应 vs 先触发拿 token 再 `GET /api/events` 订阅）；检测流同理
3. **回滚语义**：哪一步失败触发回滚、回滚本身是否作为步骤进流、回滚失败怎么办（备份恢复也失败时的最终呈现）
4. **服务端锁**：单例锁的粒度（全局一个修复/检测流 vs 按动作类型）、锁冲突时的响应（409 + 错误事件？）
5. **CLI 消费方式**：`runDetection` / persist 函数如何暴露事件回调（回调参数 vs AsyncIterable），CLI 打印格式
