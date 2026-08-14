# 修复事务生命周期集中于单一事务模块

持久化保护的编排（plan → capture → journal.plan → state.begin → execute → 逐步 transition → state.complete/fail → 逆序补偿）此前分散在 ~15 个 persist/ 文件里，生命周期次序由调用方记忆，ADR-0006 的十条可测不变量被切碎在各文件各守一段；状态提交编舞（revision 追踪 + 五字段全量提交）存在三份重复实现，recover() 是第三个平行的修复事务实现。本 ADR 决定：修复事务生命周期集中于单一事务模块目录，对外只保留四个操作与状态派生；模块内部协作降为内部细缝；本次重构行为逐字节不变。

## 背景

- 一次 protect 事务穿过 11 个公开接口（application → transaction-lock → service → planner → targets → executor → journal → state-transaction → executor → journal-reporter → state-transaction），读者须走访 15 个文件才能建立生命周期心智模型。
- 状态提交的 `let revision; const commit` 闭包在 state-transaction.ts、restore-state-transaction.ts 与 application.recover() 内联共三份；restore-service.ts:44-63 与 recover() 各实现一台 journaled backup-cleanup 阶段机。
- runProtectTransaction / runRestoreTransaction 各只有一个生产调用方（application.ts），收拢不牺牲复用。
- 评审候选 4（重复读权威存储）、候选 5（收敛式恢复二合一）、候选 6（authority 接口收缩）各有独立收益与风险，不在本次范围内。

## 决策

1. **单一事务模块**：新建 `src/persist/transaction/` 目录，唯一公开入口 `index.ts`；plan / capture / journal / execute / 补偿 / 恢复循环 / journal-reporter / 锁 / 状态提交编舞全部移入，成为内部细缝（目录内私有，不 re-export）。
2. **公开接口四操作 + 状态派生**：模块对外的行为面是 `status / protect / restore / recover` 与 `derivePersistStatus`；`application.ts` 保留 `PersistApplicationService` 类名与四方法签名（调用方 CLI / GUI / 安装器零改动），成为薄门面。
3. **authority seam 类型独立**：`ExecutableAuthority` / `WriteOutcome` / `ExecutionJournal` 抽到公开模块 `src/persist/authority.ts`；platform 适配器与测试从该处 import，不依赖事务模块内部。`steps.ts`（PersistStepId / ALL_STEP_IDS / PlanDisposition）保持公开原样。
4. **状态提交编舞合一**：一份 revision 追踪实现 + 意图方法（begin / completeProtect / failProtect / publishDaily / completeDaily / failBeforeRestore / failCleanup / publishRecovered）覆盖 protect / restore / recover 三路径；journaled backup-cleanup 抽为共享例程，restore 与 recover 共用。
5. **行为不变红线**：纯重构，ADR-0006 十条不变量、日志阶段机、补偿逆序、每槽降级提交全部保持；以现有全部用例原样通过（含 application.test.ts / runtime.test.ts / gui/server.test.ts 零改动）与覆盖率门禁不降为验收标准。
6. **排除项**：候选 4 / 5 / 6 不在本次实现，另行开票。

## Consequences

- 读一次修复事务 = 1 个模块目录 + authority/steps 两条公开 seam；11 跳阅读消失。
- ADR-0006 的不变量第一次有单一居所，新增不变量只改一处。
- 内部细缝仍有独立单测（细缝是内部测试面，不是公开接口）；公开接口的端到端行为由既有 facade 测试锁定。
- 调用方与 platform 层 import 路径调整集中在 authority.ts 一处。
