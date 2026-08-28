# 变更日志（CHANGELOG）

本文件记录每次代码变动的内容简介、版本号与修改时间。版本号以 `package.json` 为准；标注"未发布"的条目尚未进入正式 Release。

## [Unreleased] 基于 0.2.0-rc.1 — 2026-08-19

### Fixed

- **fix(packaging): 将 GUI 静态资源与离线字体纳入 Windows 安装包（2026-08-27）**
  - 修复安装后 CSS/ES 模块/字体未随 payload 分发，导致白底页面和巨型 SVG 图标的问题
  - payload 构建现在复制完整 `assets/`，安装布局升级前也校验 GUI 样式、脚本和 CJK 字体存在
  - 修复 Windows PowerShell 严格模式下 helper SHA-256 sidecar 生成失败；payload 18 项摘要验证通过

- **refactor(gui): 外置静态资源并收紧 CSP（2026-08-27）**
  - 将单文件 GUI 的 CSS 和交互脚本拆为认证本地 `assets/gui/app.css` 与 `assets/gui/app.js`
  - 将修复流生命周期（动作、进行态、浏览器重启提示）抽为纯 `assets/gui/state.js` reducer，并用 3 个单元测试覆盖状态组合；DOM 事件与渲染继续留在轻量原生模块中
  - 将检测进度与字体状态面板抽为 `assets/gui/renderers.js`，明确分隔 DOM 渲染与 SSE/API 编排，并为字体状态文案补充无 DOM 单测
  - 移除内联事件处理器与 HTML/动态模板中的内联样式，改为 CSS 类与显式事件监听
  - `script-src`、`style-src` 收紧为仅 `'self'`；静态资源提供精确 MIME、ETag 与 same-origin 策略；模块依赖 `state.js` 同样由认证本地路由提供
  - 回归：GUI 服务、reducer 与 renderer 19/19、Playwright 11/11、axe、视觉基线与发布门禁通过

- **fix(gui): 应用语义令牌与随包 SVG 图标（issue #64）**
  - 采用本地 Warp-inspired DESIGN.md 作为深色工具界面参考，整理画布、表面、文本、边框、焦点、语义色、间距和圆角令牌
  - 关键按钮、标题、网络/历史/字体/保护强度图标由 emoji 改为内联 SVG，状态信息不再依赖系统 emoji 字体
  - 保留中文字体可读性、安全动作语义和现有可访问名称；Playwright GUI 9/9 通过
  - 增加 375/840/1120/1600px 与 200% 缩放溢出门禁，以及交互元素命名/SVG 可访问树检查
  - 接入 axe serious/critical 扫描，并加入 375/840px 首屏视觉基线

- **fix(gui): 补齐字体无关的可访问性与响应式护栏（2026-08-26）**
  - 提升暗色主题辅助文本对比度，增加 `font-src 'self'` CSP 声明，避免字体资源从外部加载
  - 增加键盘 `:focus-visible`、`prefers-reduced-motion`、`forced-colors` 支持
  - 优化窄屏/大屏布局，按钮触控尺寸、历史记录换行和通知栏在 375px 视口下可用

- **fix(fonts): 接入离线 CJK UI 字体资源（issue #63）**
  - 随包提供 Noto Sans CJK SC Regular 的 UI 子集、上游来源、OFL-1.1 许可说明和 SHA-256
  - GUI 通过认证本地路由提供 `font/woff2`，使用 same-origin、immutable 缓存；未授权请求仍被拒绝
  - HTML 使用 `font-display: swap`，系统字体仍保留为回退，字体资源不可用时不影响 GUI 启动
  - Playwright 增加 `document.fonts`、preload、本地字体请求和无外网请求契约测试

- **fix(fonts): 暂停系统字体移除并补齐恢复安全闭环（2026-08-26）**
  - `/api/fonts/remove` 固定返回 410，GUI 删除破坏性入口但保留已有备份的字体还原入口
  - 每次删除前创建当前字体版本的新备份；任一字体或 HKLM Fonts 注册表材料备份失败即 fail-closed，半成品目录清理后不进入提权
  - 删除清单与刚生成的 manifest 绑定，提权端重新枚举并要求精确相等，关闭“部分备份、全部删除”及备份后目录竞态
  - 还原撤销本产品拥有的 `PendingFileRenameOperations` 删除对，避免“先还原、重启后又被删”，同时保留其他软件的队列项
  - GDI `AddFontResource`/`RemoveFontResource` + `WM_FONTCHANGE` 刷新字体表；Node 端按 manifest SHA-256/大小及注册表逐项读回，验证后才清空恢复 marker
  - 系统内置中文字体改为信息性信号（risk low、贡献 0），不再因正常 Windows 字体增加风险分或引导删除
  - 新增备份碰撞、提权前哈希验证、队列所有权等事故回归切片与禁用端点测试

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

- **fix(fonts): 关闭字体特权助手的 UAC 提权代理攻击面（issue #49）**
  - **签名方案决策**：采用零落盘 EncodedCommand 方案（无 Authenticode 依赖）——个人开发者无证书渠道（CA 基本停发个人 OV、EV 需组织主体），且"释放签名脚本再执行"仍有释放-执行篡改窗口；脚本与参数以 base64(UTF-16LE) 编入命令行快照，磁盘上不存在可替换的 `font-helper.ps1`/`font-helper-args.json`，攻击窗口从"任意时间替换常驻文件"缩小为零
  - **提权端纵深防御**：备份目录与注册表 JSON 必须 `GetFullPath` 后锚定 `font-backup` 子树（拒绝 `..` 与前缀碰撞）；备份内容拒绝 reparse point（符号链接逃逸）；移除名单不传输——提权端按同一 catalog 模式自行枚举
  - **弃用 `reg.exe import`**（任意 HKLM 写入 → IFEO/Run 键/服务持久化提权链）：注册表还原改为白名单 JSON 逐值 `New-ItemProperty` 写回固定 Fonts 键（值名/数据形状校验，数据含路径时前缀必须为 Fonts 目录）；备份格式改为 `fonts-hklm.json`（非提权读键 + 中文字体项过滤），旧版 `.reg` 备份还原时自动转换（Node 端解析 REGEDIT5，同样过滤）
  - **结果标记防伪造**：marker 写随机文件名（`font-helper-result-<uuid>.json`）+ 一次性 256 位 nonce，伪造 marker（含预写 `font-helper-result.json` 旧路径）被忽略；pendingReboot 逐项过文件名白名单、error 截断 500 字符
  - ADR-0013 决策 3-6 更新，残余风险（UAC 弹窗仍显示 powershell.exe、nonce 对能读他进程命令行者不保密）已记录
  - 测试：新增 17 个用例（脚本组装结构断言、Node 端锚定预检、reg 解析含非 Fonts 段忽略/转义、nonce 拒绝与内容过滤、旧 .reg 转换、真实 PS 5.1 冒烟——非提权运行验证语法/锚定/错误 marker 通道）；全量 65 文件 641 用例通过

- **fix(persist): 关闭 native-helper 路径的环境变量与 CWD 劫持面（issue #53）**
  - `resolveNativeHelperPath` 重写：移除 `join(process.cwd(), 'native-helper', ...)` 回退（在下载目录/网络共享运行 CLI 时会执行攻击者预置的同名路径）；解析顺序改为 显式参数 → bundle 相对布局 `<dist>/../native/`（npm 与桌面载荷的正式位置）→ 环境变量（仅接受绝对路径、排在 bundle 之后——合法安装永远命中 bundle，env 退化为开发兜底）
  - 桌面壳（main.rs）：可执行/脚本组件路径（node/sidecar）在 release 构建对环境变量覆盖 fail-closed（debug 保留以支持仓库开发布局）；不再向 sidecar 传递 `CC_FIX_NATIVE_HELPER`（sidecar 以 bundle 相对布局解析，与安装目录一致）
  - 哈希 sidecar（纵深防御）：打包脚本为 helper 写 `cc-fix-native-helper.exe.sha256`，运行期解析时校验、不匹配 fail-closed（INITIALIZATION_FAILED）——为无 Authenticode 的分发提供篡改可见性；`cc-fix.cmd` 移除冗余 env 设置
  - 残余风险：便携解压布局下模块相对路径本身位于不可信目录（无代码签名不可解，ADR-0010 层面）；sidecar 与 exe 同目录，防不了有写权限的定向替换
  - 测试：runtime.test.ts 新增 4 用例（CWD 回退移除回归、绝对/相对 env 区分、sidecar 不匹配 fail-closed、匹配/缺失容忍）；main.rs 新增 3 用例（release 拒绝覆盖/debug 允许/缺省回落安装目录）

- **fix(desktop): 日志脱敏规则补齐 JSON 键值、截断 PEM 与标准 base64 绕过面（issue #54）**
  - 新增规则 7：JSON 键值形态 `"api_key": "value"`（键后允许闭引号，值扫描到闭引号/逗号/右花括号），敏感键与值整体替换为 `[redacted]`
  - 截断 PEM：`-----BEGIN` 出现但无 `-----END` 时替换至消息末尾（旧规则要求找到 END 才整块替换，截断块主体泄漏）
  - base64 run 字符集扩展为标准 base64（含 `+` `/` `=`）：旧 base64url 字符集会把 64 字符 PEM 行切成不足 43 的短段逃逸掩码（一行 PEM body 约 86% 概率含 `+` 或 `/`）
  - 测试：corpus 扩充 4 个形态（截断 PEM、含 +/ 的标准 base64、JSON 键值、嵌套 JSON）+ 占位符形状断言（`[redacted]`/`[private key]` 出现、普通键 `"mode": "standard"` 保留）；9 个 Rust 测试通过

- **fix(installer): 升级/卸载执行 HKCU 记录的启动器前做一致性核验（issue #55）**
  - `InitializeSetup`（升级 preflight 前）：`TrustedInstallRecord` 三重核验 fail-closed——UninstallString 目录与 InstallLocation 一致（检出单值篡改）、安装目录存在完整产品布局（bin/core/runtime/CC-Fix.exe，伪造目录需复制全套载荷）、`cc-fix.cmd` 形状符合产品启动器（首行 `@echo off` 且引用 `runtime\node.exe` 与 `core\index.js`）
  - `InitializeUninstall`（persist off 前）：同样的布局与启动器核验；失败时跳过该步骤（等价 /PRESERVESTATE 语义）并提示，绝不执行形状异常的启动器
  - 残余风险：无 Authenticode 时非密码学信任根——同用户持久攻击者可一致地伪造注册表与目录；DisplayVersion 降级防护同属可篡改面（已记录）
  - 验证：ISCC 哑载荷编译通过（Pascal 语法与常量展开端到端）

- **fix(ci): 密钥扫描门禁 fail-open 面与规则盲区收口（issue #56）**
  - 不可读文件不再静默跳过：readFile 失败记 `unreadable` 发现项并判失败（fail-closed）
  - `generic-assignment` 规则放宽补盲：值不再要求引号包裹（`API_KEY=xxx`）、键后允许闭引号覆盖 JSON 形态、字符集补 `.` `/` `+`、阈值 24→16
  - 符号链接不再静默跳过：文件链接扫目标；目录链接仅递归指向仓库内部者（realpath 前缀 + 已访问集合防环）；损坏链接记 `unreadable` 判失败
  - `--allow` 改为别名制：只接受 `scripts/ci/secrets-allowlist.txt` 登记的别名（`别名=子串`，随仓库评审）——CI 调用行被篡改也无法放行任意子串；白名单文件本身不作为扫描对象；未知别名/损坏白名单行 fail-closed
  - sidecar.ts 局部变量改名 `sessionToken`（放宽后的规则按关键词扫描赋值形态，裸 `token = process.env.XXX` 会误报）
  - 测试：ci-gates 新增 5 用例（未引号/JSON 赋值、损坏链接、目录链接引入的密钥、别名制白名单含篡改形态、损坏白名单行）；全仓库门禁扫描通过

- **fix(persist): journal 代回退读取的恢复决策保守化（issue #57）**
  - `TransactionJournalRepository.readWithDegradation()` 暴露降级标志：current 代损坏、内容来自 `.prev` 回退时 `degraded: true`（`.prev` 是旧代，phase 只可能滞后于崩溃现场）
  - `recover()` 将降级标志传入 `recoverProtectTransaction`：降级时 planned 步骤不再走"无写关闭"捷径（旧实现直接标记 compensated——而现实中该步骤可能已写入 desired，导致系统停留在 desired 而状态机认为已回滚），改为先推进 `recovery_required` 再走补偿写回 original 的最保守路径
  - 非 degraded 路径不变：权威读取下 executor 在权威写之前先落 applying，planned 步骤确未开始写、无写关闭安全；restore 恢复本就全量重验（无需改动）
  - 测试：journal.test.ts 新增降级读取用例（损坏 current → .prev 滞后 phase + degraded 标志）；recovery-executor.test.ts 新增降级 planned 全量回写用例（与权威 planned 无写关闭形成对照）

- **perf(cli): 启动路径按命令惰性加载 GUI/persist/injector 全家桶（issue #60）**
  - `cc-fix check`/`run` 等高频命令不再在启动路径加载 `gui/server.js`（含 index.html 文本内联 + fonts/session 全家桶）、`persist/runtime.js`（native-backend/migration/authorities/durable-file）、`persist/preflight.js`、`run/injector.js`——顶层静态导入改为命令 action 内 `await import(...)`
  - 新增 `openPersistRuntime()` 惰性 loader：persist 五个子命令共用；preflight 的 `installerPreflightExitCode`、run 的 `runWithInjectedEnv/runDesktop`、gui 的 `startGuiServer` 均按需动态加载
  - 收益：`check`/`status` 冷启动不再解析 30+ 个多余模块（估 50~150ms）；改动局限 index.ts 单文件

- **perf(state): 迁移哨兵跳过 noop 迁移 + 进程 StartTime 查询缓存（issue #58）**
  - 迁移哨兵 `legacy-migration.json`：迁移收敛（migrated/noop）后原子写；此后 runtime 创建先无锁 stat 哨兵、命中即跳过 `migrateLegacyProtection`——已迁移用户的每条 persist 子命令不再付"拿 root 锁 + PowerShell 查进程 StartTime + classifier 读全部权威"的开销（估每条 150~600ms）
  - 哨兵含版本号（当前 1），将来 schema 升级改版本强制重迁移；哨兵被删只触发一次幂等重迁移；recovery_required/failed 不写哨兵（下次重试）
  - `createWindowsProcessInspector` 的 StartTime 查询按 pid 加 5s TTL 缓存：锁竞争路径（acquire + isSameProcess 对同一持有者）与 GUI 常驻进程重复查询同一 pid 时只 spawn 一次 PowerShell
  - 测试：runtime.test.ts 新增哨兵写入/幂等跳过/删除与版本不符重迁移 2 用例；lock.test.ts 新增查询缓存计数用例（TTL 内 1 次、过期重查）

- **perf(persist): journal 拆分 phase 表与快照值文件，transition 只重写小文件（issue #59）**
  - 原实现：每次 phase 转换把带全部步骤 original/desired（完整系统配置）的 journal 全量重写——10 步事务 ≈ 21 次全量写 + 84 次 fsync（估 300~600ms）
  - 新实现：`plan` 先写 values 快照（`transaction-journal.json.values`，含完整快照值，schema `cc-fix-transaction-journal-values-v1`）再写 phase 表（剥值）；`transition` 只重写 phase 表（KB 级）；读取时 `mergeValues` 透明合并，`TransactionJournal` 对外形状不变
  - 崩溃安全：values 先写后 journal 缺失 → 下次 plan 以新 transactionId 覆盖；journal 写后 values 必然已存在；合并时校验 transactionId 匹配
  - 向后兼容：旧格式（值内嵌 steps 的单文件）读取直接返回，不触碰 values 文件
  - 测试：新增 phase 表剥值断言（journal.json 不含 original/desired、values 文件含快照）、transition 后读回合并完整值、旧格式 envelope 兼容读取；全量 persist/state 349 用例通过

- **perf(gui): 探测/查询全面异步化，不再阻塞事件循环（issue #61）**
  - `detectRunningBrowsers`：逐浏览器 `execSync tasklist /FI`（每次阻塞 30-100ms × 2，GUI SSE 常驻服务里冻结全部请求）→ 一次异步 `tasklist /NH` 列全量 + 内存匹配多个镜像名
  - `getPolicy`/`readUserEnvVar`/`readUserLocale`：`execSync reg query` → 异步 `execFile`（返回 Promise，调用方已 await）
  - `computeSystemState` 子进程探测失败：从静默回落改为 `console.warn`（常驻进程用 launch-time TZ 快照打分的退化可观测，issue #45 根因场景）
  - 测试：browser.test.ts 重写为 execFile 回调 mock（全量输出多镜像匹配/失败降级/空结果 + getPolicy 成功/失败/目录外拒绝）；server.test.ts browser-hint 用例经 `Promise.resolve` 包装兼容同步 mock
