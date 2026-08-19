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

- **fix(state): 锁系统死锁闭环修复——崩溃残留锁可接管、claim 竞态串行化、存活探测失败不再误判死亡（issue #51）**
  - H1（崩溃一次即永久锁死）：`persist recover` 与迁移层（`migrateLegacyProtection`）现在可以在持有者被确认死亡后接管残留 root 锁；恢复流程内（root gate 已持有时）repository 的 scoped 锁同样允许接管。普通 protect/restore 保持 fail-closed（退出码 21 引导用户走 recover），闭环：崩溃 → recover 接管 → journal 收敛 → 锁清理
  - H2（heartbeat 与 release 的 claim 竞态）：`FileLockStore` 对 replace/remove 按锁路径做进程内串行化（模块级队列，跨实例共享——协调器每次 acquire 新建 store 实例）；replace/remove 改按锁身份 `lockId` 匹配而非整条记录，并发心跳导致的 `heartbeatAtMs` 过期不再误判 "Lock ownership was lost" 致锁文件永不删除
  - M1（与 H1 同批落地）：PowerShell 探测改为 `SilentlyContinue` + `MISSING` 标记——"进程确认不存在"与"查询失败"分离；`isSameProcess` 查询失败一律上抛，接管路径不会把活着的持锁进程误判为死亡（避免双持锁并发写）
  - L1：`acquireStateMutationLock` 递归重试上限 16 次，持续竞争收敛为显式失败；L2：瞬时心跳失败被后续成功清除，release 不再误抛旧错误
  - 测试：新增 10 个用例——真实文件锁 + 真实 PowerShell 的 kill -9 等价模拟（死 PID 残留锁 → recover 接管 → 锁文件删除 → 后续操作直接成功）、1ms 心跳持续竞态 release、store 层并发 claim 串行化、lockId 匹配、查询失败上抛、递归上限、仅 recover 操作接管的编排契约、root 持有下 scoped 接管授权；全量 63 文件 627 用例通过
