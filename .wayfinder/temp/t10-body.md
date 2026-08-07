## Question

无新决策——把本图全部决议（地图 Notes 的 12 条锁定决策 + 「修复步骤流 UI 原型」的 UI 形态 + 「事件协议与回滚机制设计」的协议决议）汇总为一份**决策完备的实施规格**，写入 `.wayfinder/research/`，内容按实施顺序组织：

1. 统一事件层类型定义（共享模块位置、导出）
2. `src/platform/windows.ts` / persist 流程改造点（步骤化 + 回滚钩子）
3. `src/gui/server.ts` 的 SSE 端点与锁
4. `src/gui/index.html` 前端流渲染（按 UI 原型票定稿形态）
5. CLI 端事件打印
6. 各改动的测试要点

规格完成后本图到边——交棒实施。
