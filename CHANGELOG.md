# 变更日志（CHANGELOG）

本文件记录每次代码变动的内容简介、版本号与修改时间。版本号以 `package.json` 为准；标注"未发布"的条目尚未进入正式 Release。

## [Unreleased] 基于 0.2.0-rc.1 — 2026-08-19

### Fixed

- **fix(cli): `persist on` 降级路径退出码接线（issue #50）**
  - degraded 结果现在按契约设置退出码 2（`EXIT_DEGRADED`），此前该分支退出码保持 0，`EXIT_DEGRADED` 为死常量
  - 人类可读输出在降级时改用黄色提示（原为绿色"✓ 已提交"）；JSON 输出保持 `degraded` 数组事实字段
  - GUI（`handleFixOn`）对 degraded 单独呈现：summary 事件新增 `degraded`（未对齐浏览器策略槽 id 列表），前端显示"降级 N 项"徽标与"修复完成（部分浏览器策略降级）"标题
  - 测试：`src/gui/server.test.ts` 新增 degraded summary 广播用例（ok=1/fail=0 + 槽位列表）；全量 63 文件 614 用例通过，`tsc --noEmit` 通过
