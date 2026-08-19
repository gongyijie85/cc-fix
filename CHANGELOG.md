# 变更日志（CHANGELOG）

本文件记录每次代码变动的内容简介、版本号与修改时间。版本号以 `package.json` 为准；标注"未发布"的条目尚未进入正式 Release。

## [Unreleased] 基于 0.2.0-rc.1 — 2026-08-19

### Fixed

- **fix(cli): `persist on` 降级路径退出码接线（issue #50）**
  - degraded 结果现在按契约设置退出码 2（`EXIT_DEGRADED`），此前该分支退出码保持 0，`EXIT_DEGRADED` 为死常量
  - 人类可读输出在降级时改用黄色提示（原为绿色"✓ 已提交"）；JSON 输出保持 `degraded` 数组事实字段
  - GUI（`handleFixOn`）对 degraded 单独呈现：summary 事件新增 `degraded`（未对齐浏览器策略槽 id 列表），前端显示"降级 N 项"徽标与"修复完成（部分浏览器策略降级）"标题
  - 测试：`src/gui/server.test.ts` 新增 degraded summary 广播用例（ok=1/fail=0 + 槽位列表）；全量 63 文件 614 用例通过，`tsc --noEmit` 通过

- **fix(run): injector spawn 三重缺陷修复（issue #52）**
  - 移除 `shell: true`：参数数组原样传递，`& | ^ %` 等 shell 元字符不再被解释（消除参数注入面）
  - 含空格的命令路径（如 `C:\Program Files\Claude\Claude.exe`）现在可以直接启动——此前默认安装路径下 Claude Desktop 无法通过 `cc-fix run --desktop` 启动
  - 监听 spawn `error` 事件并 reject：spawn 失败（ENOENT/EACCES）由顶级 catch 归类为契约退出码 30，不再导致进程崩溃
  - 信号终止（code=null）按 shell 惯例映射 128+n（SIGTERM→143），不再被当作成功 0
  - 附带：`gui` 命令的浏览器 opener 按平台选择（win32: rundll32 / darwin: open / linux: xdg-open）并监听 error，非 Windows 不再崩溃；`runDesktop` 内的 `require("node:fs")` 清理为顶层 ESM import
  - 测试：新增元字符透传、含空格路径（junction/符号链接）、ENOENT reject、POSIX 信号映射 4 个用例；真实 CLI 冒烟验证（`run -- node -e … "a&b"` exit 0；`run missing` exit 30 INTERNAL）；全量 63 文件 617 用例通过
