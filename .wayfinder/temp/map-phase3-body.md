## Destination

产出一份**决策完备的实施规格**：让 Web UI 中的修复（persist on/off）与检测过程实时可见——SSE 步骤流 + 失败自动回滚 + CLI/GUI 同源事件层。规格完成即交棒实施，不在地图内直接实现完整功能。

## Notes

- 领域：Claude Code 环境安全检测工具的 UX 增强（Web UI + CLI）
- 代码基线：`src/gui/server.ts`（本地 HTTP + 3456 端口）、`src/gui/index.html`、`src/platform/windows.ts`（createBackup/restoreBackup/setEnvVar）、`src/detection/runner.ts`
- 工作目录：`D:\cc-fix`

### 绘制时已锁定的决策（grilling 两轮）

1. 本努力是**独立新地图**，与 Phase 2（检测维度补全）正交
2. 载体**仅 Web UI**；桌面壳若将来做，设计可平移
3. 可视化范围：**Persist On / Persist Off 必做**，检测过程顺带做；未来自动修复动作不在本图
4. 形态：**实时步骤流 + 最终汇总**（不是进度条）
5. 通道：**SSE**（零依赖，Node 原生 http 实现）
6. 失败策略：**中止 + 自动回滚**（备份兜底，不产生半修复状态）
7. 步骤颗粒度：步骤名 + 状态 + **旧值 → 新值** + 失败时的错误信息
8. 检测可视化：**并行执行 + 增量推送**（固定顺序占位，结果到达即填充）
9. **CLI/GUI 统一事件层**：事件抽成共享结构，CLI 逐步打印、GUI 走 SSE
10. 交付物是**实施规格**，地图走完交棒实施
11. 并发防护：**前端禁用按钮 + 服务端单例锁**（双标签页场景）
12. 修复完成后**自动重新检测**并展示前后评分对比

## Decisions so far

<!-- 关闭的票据索引，一行一条 -->

- [#2 修复步骤流 UI 原型](https://github.com/gongyijie85/cc-fix/issues/2) — 采用变体 B（步骤清单卡片）：序号圆圈+步骤名+旧→新值+状态徽章，错误内联、回滚追加、底部汇总+评分对比；修复中禁用按钮、检测固定占位增量填充
- [#3 事件协议与回滚机制设计](https://github.com/gongyijie85/cc-fix/issues/3) — 可辨识联合事件 schema（src/events/types.ts）；常驻 SSE 通道 GET /api/events + POST 触发端点，删旧同步端点；失败只回滚已改键、off 无回滚、fatal 不重试；单把全局锁 409；编排层 src/fix/flow.ts 回调式，CLI/GUI 同源，CLI 不自动复测
- [#4 汇总实施规格](https://github.com/gongyijie85/cc-fix/issues/4) — 410 行实施规格写入 `.wayfinder/research/phase3-implementation-spec.md`，覆盖事件层/编排层/SSE 端点/前端渲染/CLI 消费/测试要点，实施顺序已定

## Not yet specified

- **未来自动修复动作的接入**：事件 schema 的扩展方式已定（新增事件种类），但 DNS/注册表区域/代理等真实修复动作本身及其步骤流设计仍未定
- **桌面壳打包**：Tauri/Electron 包一层浏览器视图的可行性与事件层兼容性
- **修复前后逐项对比高亮**：评分对比已定（决策 12），但信号表里逐项标出"哪些被修复改变"尚未明确
- **环境值实时面板**：原型变体 C 的"TZ/LANG/LC_ALL 值闪光更新"可作为变体 B 的可选增强，尚未决定要不要

## Out of scope

- **新增自动修复动作的实现**（真实改 DNS/注册表/代理）— 本图只可视化既有 persist on/off，新修复动作属另一努力
- **修复报告落盘/日志文件** — 屏幕上的实时流 + 汇总已满足"看得见"
- **浏览器端检测项**（WebRTC 等）— 继承 Phase 2 范围外决议
