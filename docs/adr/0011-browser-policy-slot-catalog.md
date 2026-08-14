# 浏览器策略槽目录与每槽降级语义

六个浏览器策略槽（Chrome/Edge 的 AcceptLanguage、DefaultWebRtcIPHandlingPolicy、ApplicationLocaleValue）此前以两套键空间并存：槽 id（`chrome.accept_language`，备份 v4 / 事务日志 / 状态校验使用）与 slotKey（`chrome/AcceptLanguage`，`platform/browser.ts` 与检测插件使用）。persist 期望值用 slotKey 词汇、authority 校验用槽 id 词汇，导致每次 `persist on` 都在 browser_policies 步抛 INVALID_VALUE 致命回滚（2026-08 架构评审发现）；执行器的整步降级启发式还假定“写入被拒 = 无本地改动”，与六槽循环写入矛盾，会在部分写入时丢弃补偿记录。本 ADR 决定：槽 id 为唯一规范词汇，槽目录单点持有全部槽事实，降级提交按每槽粒度实现，并以 fail-closed 顺序落地。

## 背景

- ADR-0003 引入浏览器策略持久化与降级提交意图：`previousBrowserPolicies` 按槽快照，降级时展示未对齐的策略槽。
- 实现产生了第二套词汇：`state/schema.ts` 的 `BROWSER_POLICY_SLOTS`（槽 id + keyPath + valueName）与 `platform/browser.ts` 的 `POLICY_SLOTS` + `slotKey`；唯一连接是迁移模块的 `LEGACY_POLICY_TO_V4` 翻译桥。
- 后果一（活缺陷）：`targets.ts` 的 `desiredValues` 产出 slotKey 键，`createBrowserPolicyProfileAuthority` 的 validate 要求槽 id 键——写入必抛 `AuthorityError('INVALID_VALUE')`，保护转换在策略步致命失败并整体回滚。
- 后果二（潜在缺陷）：executor 的降级分支整步 `modified.pop()`，但复合 authority 循环写六槽，第 2+ 槽被拒时前面已写入且无日志记录；该分支此前因键空间缺陷不可达，目录修复后立即变为可达。
- `schema.test.ts` 的归一化测试掩盖了键集合差异；CI 无真实 persist-on 冒烟测试，缺陷漏网。

## 决策

1. **槽 id 为唯一规范词汇**（六个 `chrome.accept_language` 形态的槽 id）；slotKey 仅为旧 v3 迁移输入的词汇，`LEGACY_POLICY_TO_V4` 保留在 `migration.ts` 内部作为输入映射，不再承担运行时翻译。
2. **槽目录 = `state/schema.ts` 的 `BROWSER_POLICY_SLOTS`**（id、browser、keyPath、valueName），并承载策略期望值的纯函数推导所需常量；检测插件、`persist/targets.ts`、`backup-mapper.ts`、`platform/browser.ts` 全部从目录派生，任何模块不得再各自声明槽列表或第二套键。
3. **fail-closed 落地顺序**：第一步（T1）目录统一 + 策略写入失败按必需步处理（整步逆序补偿、致命，降级提交暂禁用）；第二步（T2）以每槽结果对象恢复降级提交。T1 单独落地时产品不产生新的部分写入路径。
4. **每槽降级语义**：被拒/受管的槽不写入，已写入的槽保留；事务提交为降级，健康状态 degraded，未对齐槽逐槽记录（槽 id + 原因）。事务日志仍按步骤级记录——原值与期望值本身就是六槽 profile，崩溃恢复可逐槽还原，无需逐槽日志。
5. **移除 `managed` 降级原因**：没有生产代码产出它（native-backend 只映射 access_denied），且 reg.exe 错误文本无法可靠区分“组织策略”与“访问被拒”；仅保留 `access_denied`，将来有真实组织策略探测时再加回。
6. **删除死代码**：`snapshotPolicies` / `restorePolicies` / `setPolicy` / `deletePolicy` 均无生产调用，随 T1 删除；`detectRunningBrowsers` 保留并恢复 `browser-hint` 待生效提示的生产侧（与 T1/T2 同批交付，ADR-0006 的“待生效提示”此前整体不工作）。
7. **测试**：目录 round-trip 单元测试（期望值 → 快照 v4 → 日常值，键空间错配从此成为类型错误）；真实 Windows persist-on 冒烟测试接入 CI（persist on → `reg query` 校验六槽与状态提交 → persist off 完整还原），补上曾经漏网的那一层网。

## Consequences

- 修复 `persist on` 永久回滚；降级提交首次按 ADR-0003 的每槽意图真实可达。
- 备份 v4 与事务日志的键空间不变（槽 id 本就是其格式），无需数据迁移。
- 检测插件的外部输出文本逐字节不变，仅内部比较键改为槽 id。
- 新增槽位或受管键只改目录一处；键空间错配从运行时错误变为类型错误。
- fail-closed 期间，策略写入被拒表现为与其他必需步一致的致命失败（补偿回滚）；T2 落地后恢复“降级提交 + 展示未对齐槽”的 UX。