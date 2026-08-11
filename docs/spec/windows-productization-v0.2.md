# Spec: CC-Fix Windows 产品化 0.2

## Status and authority

- 状态：Approved for implementation。
- 目标版本：`0.2.0-rc.1`，通过门禁后晋级 `0.2.0`。
- 本规格汇总 ADR 0004–0010 与 Wayfinder 地图的已确认决议，是 Windows 0.2 实施和验收的直接输入。
- 当旧 `SPEC.md`、`README.md`、安装脚本、测试或当前代码与本规格冲突时，以 `CONTEXT.md`、ADR 0004–0010 和本规格为准；实现批次必须同步修正文档与旧测试。
- 本规格不重新解释或扩大已确认范围。没有遗留产品决策；工具链补丁版本、文件名等可逆细节由实现按本规格固定并记录。

## Objective

把当前依赖系统 Node.js 的 CLI/本地 Web GUI 收敛为公开可发布的 Windows 10/11 x64 产品：

1. 保留独立 CLI，并提供 Tauri v2/WebView2 独立桌面入口。
2. 默认标准保护，显式深度保护；两者及跨地区切换均可验证、可补偿、可完整还原。
3. 地区目录、偏好地区、生效地区和本次目标地区使用单一领域模型，检测、修复、状态、复测和历史一致。
4. 使用私有 Node.js 24 LTS 与单文件 ESM bundle，无需用户预装 Node.js，首次启动不依赖网络。
5. 使用 Inno Setup 6.7.x 生成当前用户单 EXE 安装包，支持安装、升级、修复、安全卸载和保留状态重装。
6. 生成可追溯、可校验、可人工批准的 Windows RC 与正式版发布证据包。
7. VPN、路由器、路由表、网络适配器和 DNS 等外部网络配置始终只检测、解释和提醒，不自动修改。

## Locked assumptions

- 首发只支持 Windows x64；macOS、Linux、Windows ARM64 与自动更新不在本轮。
- GitHub Release 的 Windows EXE 是主要入口；npm CLI 是同版本、同提交的兼容渠道。
- 桌面壳不承载检测或修复领域逻辑；CLI、GUI 和桌面壳共用一个核心 bundle。
- 应用和本地 GUI 服务默认普通用户权限；只有白名单浏览器策略写入可经用户确认启动短时特权助手。
- 标准保护包含 TZ、LANG、LC_ALL、Windows 系统时区和 Chrome/Edge 语言/WebRTC 策略；保留 Windows Locale、语言列表和 Culture。
- 深度保护包含标准保护并额外对齐 Windows Locale、首选语言列表和 Culture。
- 字体、VPN、代理节点、路由、网卡、hosts、DoH 和 DNS 配置均不进入 persist 自动修改范围。

## Scope

### In scope

- 新保护状态、地区状态、备份、事务日志、独占锁、迁移和恢复仓储。
- 标准/深度保护、升级/降级、换区、重复对齐和完整还原事务。
- CLI、GUI API、GUI 页面、历史和检测上下文的统一状态语义。
- Tauri 桌面会话、localhost 认证、单实例、进程回收、恢复页、脱敏诊断。
- 私有 Node 运行时、ESM `noExternal` bundle、独立 CLI launcher。
- Inno per-user 安装器、WebView2 离线前置、PATH、快捷方式、升级/修复/卸载。
- CI、Windows 客户端验收、SBOM、SHA-256、attestation、条件 Authenticode 与 npm OIDC 发布。
- README、SPEC、CLI help、安装/升级/卸载与发布说明同步。

### Out of scope

- 自动更新服务、后台常驻服务、系统托盘驻留。
- Electron 重写或检测引擎重写。
- 新增检测维度、代理切换、VPN/DNS/路由器自动修复。
- all-users/machine-wide CC-Fix 安装、多正式版本并存、旧安装器覆盖新版本。
- Windows ARM64、x86、macOS 与 Linux 产品包。

## Tech stack

| Area | Required technology |
|---|---|
| Core | TypeScript strict mode、Node.js 24 LTS x64 private runtime、ESM |
| Bundle | tsup/esbuild 单文件 `noExternal` bundle；不得保留第三方运行时 imports |
| Unit/integration | Vitest；关键状态与事务使用故障注入 |
| GUI E2E | Playwright 驱动现有 HTML/HTTP/SSE 服务 |
| Desktop | Tauri v2、Rust stable toolchain、Microsoft WebView2 Evergreen |
| Installer | Inno Setup 6.7.x，per-user、单稳定 `AppId` |
| Windows acceptance | PowerShell 驱动的干净客户端 VM/真实机生命周期 harness，输出机器可读证据 |
| Release | GitHub Actions、Artifact Attestations、CycloneDX JSON、npm Trusted Publishing |

初始实现以原型验证过的 Node.js 24.18.1 与 Tauri 2.11.5 为基线。所有实际发布工具必须在 `toolchain.lock.json` 固定精确版本、官方来源和 SHA-256；升级补丁版本需要重新通过构建及客户端门禁。

## Target commands

以下命令是实现必须提供的稳定入口；在对应批次完成前可暂不存在：

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm test:integration
pnpm test:gui
pnpm build:core
pnpm build:desktop
pnpm build:installer
pnpm verify:payload
pnpm test:windows -- --matrix primary
pnpm release:bundle -- --version 0.2.0-rc.1
```

底层可由这些命令调用：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --release --locked --manifest-path src-tauri/Cargo.toml
powershell -File scripts/windows/Test-InstallerLifecycle.ps1 -Installer artifacts/CC-Fix-0.2.0-rc.1-win-x64.exe
```

任何公开资产只能由 tag 触发的受控 CI 调用相同入口构建。本地命令只产生开发产物。

## Target project structure

```text
src/
  domain/              # 纯领域类型、地区解析、保护计划和不变量
  state/               # schema、校验、原子文件、迁移、仓储、锁和 journal
  persist/             # 计划、执行、读回验证、提交、补偿和收敛恢复
  platform/windows/    # Windows 权威存储 adapter；无事务编排
  detection/           # 现有检测插件，统一消费 resolved target context
  history/             # 追加式操作日志及 schema
  cli/                 # Commander 命令与退出码映射
  gui/                 # 认证本地服务、HTTP/SSE 与静态页面
  release/             # 版本、载荷清单和 build-info 生成逻辑
src-tauri/             # Tauri 薄壳、单实例、子进程与原生错误/恢复页
privileged-helper/     # 可独立审计的白名单策略助手
installer/             # Inno scripts、固定 AppId、组件与消息资源
scripts/windows/       # 客户端安装生命周期 harness
scripts/release/       # 下载校验、SBOM、签名、hash、attestation 前置
tests/integration/     # 核心/GUI/CLI 跨模块测试
tests/windows/         # VM 场景定义、fixture 和期望证据
docs/spec/             # 本规格与验收矩阵
tasks/                 # 依赖计划与逐项实施清单
```

迁移期间允许当前文件与目标目录短期并存，但新模块不能反向依赖旧 `src/fix/flow.ts` 的隐式状态语义。旧 flow 只作为行为迁移入口，最终由新 persist application service 取代。

## Domain model

### Core types

```ts
type RegionCode = "us" | "eu" | "jp" | "sg";
type ProtectionMode = "daily" | "standard" | "deep";
type ProtectionHealth = "healthy" | "degraded" | "recovery_required";
type ProtectedMode = Exclude<ProtectionMode, "daily">;

interface ProtectionTarget {
  mode: ProtectedMode;
  region: RegionCode;
}

interface ProtectionState {
  schemaVersion: 1;
  revision: number;
  committedTarget: ProtectionTarget | null;
  preferredRegion: RegionCode;
  health: ProtectionHealth;
  degradation: DegradationReason[];
  activeTransactionId: string | null;
  updatedAt: string;
}

type StoredValue<T> =
  | { kind: "missing" }
  | { kind: "value"; value: T };
```

`StoredValue<T>` 必须区分不存在、`null`、空字符串与空列表；不能以 truthy 判断决定是否恢复。`committedTarget=null` 才表示日常状态。备份存在、journal 存在或当前设置接近某地区都不能单独决定保护模式。

### Region resolution

地区目录是唯一有效值集合。所有入口先解析 `ResolvedRegion { code, source }`，source 为 `explicit | active | preferred | initial_default`：

- `check`/`run`/`persist on` 显式 `--region` 优先。
- 未显式指定时，保护状态使用生效地区，日常状态使用偏好地区。
- 仅首次没有合法偏好记录时使用 `us` 的 `initial_default`。
- 非法 CLI 输入输出合法地区列表并非零退出；GUI server 即使前端来自下拉框也必须重新校验。
- `check` 和 `run` 的显式覆盖不写状态。
- 日常 `region set <code>` 更新偏好；保护状态拒绝并引导使用正式保护目标转换。
- 成功保护转换同时提交 active 与 preferred；失败两者均保持旧值；off 清 active、保留 preferred。

### Protection transition matrix

| From | Request | Required behavior |
|---|---|---|
| daily | `persist on` | standard + resolved region；创建一次不可覆盖日常快照 |
| daily | `persist on --deep` | deep + resolved region；显式深度确认已由参数表达 |
| protected | `persist on` | 保持当前强度和地区，检查并补齐漂移 |
| protected | `persist on --region X` | 保持当前强度，原子切换地区 |
| standard | `--level deep` | 只新增并验证深度项，成功后提交 deep |
| deep | `--level standard` | 恢复深度独有日常值，保留标准项，成功后提交 standard |
| protected | 同时指定 level/region | 作为一个不可分割的 protection target 转换 |
| protected | `persist off` | 向不可覆盖日常快照收敛，全部验证后提交 daily |
| daily | `persist off` | 幂等 no-op，退出码 0 |
| recovery_required | 新转换 | 拒绝；只允许查看、诊断和 recover/off |

标准保护写入环境变量、Windows 系统时区和浏览器策略。深度保护额外写入 Windows Locale、首选语言列表和 Culture。字体与外部网络配置永不进入步骤计划。

### Health and degradation

- `healthy`：所有当前强度必需权威存储已读回对齐，且无未完成事务。
- `degraded`：只允许用于已明确分类为组织管理或访问被拒的浏览器策略槽；提交目标但列出每个未对齐槽。
- `recovery_required`：journal 未完成、补偿不完整、状态/备份损坏回退、旧 schema 无法安全迁移或完整恢复尚未收敛。
- 其他必需步骤失败不能提交 degraded，必须补偿并保持旧 committed target。

## Durable state and migration

### Files

用户状态继续位于 `%APPDATA%\cc-fix`：

| File | Ownership and purpose |
|---|---|
| `state.json` | 当前 committed target、偏好、健康、revision 和 active transaction pointer |
| `persist-backup.json` | backup schema v4，不可覆盖日常快照 |
| `transaction.json` | 当前耐久事务的计划、步骤原值/目标值与进度 |
| `persist.lock` | transaction id、PID、进程启动时间与心跳 |
| `history.jsonl` | 追加式检测/转换操作日志 |

状态、备份和 journal 使用 schema 校验、内容校验值、同目录随机临时文件、文件 flush、原子替换和最近一个校验通过的 `.prev`。读取当前文件失败时只回退到有效 `.prev`，并把健康标记为异常。原始备份一旦创建，不因重复 on、换区、强度切换、升级或修复安装而覆盖。

### Transaction journal

journal 至少记录：事务 ID、kind (`protect | restore | recover`)、旧 target、请求 target、状态 revision、步骤有序列表、每项 `original`/`desired`、`pending | applying | verified | compensating | compensated | failed`、错误分类、创建/更新时间和校验值。

每个系统写步骤按以下顺序执行：

1. 持久化完整计划和原值。
2. 将步骤标为 applying 并 flush。
3. 写 Windows 权威存储。
4. 从权威存储重新读取并严格比较。
5. 将步骤标为 verified 并 flush。
6. 所有必需步骤满足提交条件后原子更新 state revision/target/health。
7. 追加 history；日志失败只报告 observability degradation，不撤销已提交系统设置。

保护失败按逆序尝试补偿全部已修改项，单项补偿失败不停止后续补偿。restore/off 不逆向恢复保护态：它尝试全部日常值，已验证项保持，失败项供幂等重试。

### Lock and crash recovery

活锁只能由同一 transaction owner 更新心跳。新修改请求遇活进程锁返回 busy。接管必须验证 PID 与进程启动时间不再匹配，不能仅按文件年龄。接管后优先恢复 journal，不允许开始新保护转换。

应用、CLI 或桌面启动发现未完成 journal 时进入 recovery_required。只读 status/check/history/diagnostics 可用并标注未提交事务；检测结果不参与 recheck。`persist recover` 根据 journal kind 补偿旧 target 或继续向 daily 收敛。

### Legacy migration

1. 没有旧备份：创建 daily state；读取合法持久偏好，否则首次默认 us。
2. 旧 backup v3 有合法 `activeRegion`：导入 committed region 与 preferred region，再按权威设置判断可证明的强度/健康。
3. 地区缺失或非法：只有当前设置唯一匹配地区目录时才导入；不能唯一匹配则 recovery_required，不假定 us。
4. 缺失的日常原值不能用当前保护态补齐。保留旧文件，创建只读迁移副本并引导恢复。
5. 迁移先备份和校验，最后原子提交新 state；任何失败不得改写旧备份。

## Platform adapter boundary

领域/事务层只能通过结构化 Windows adapter 读取和写入：环境变量、系统时区、浏览器策略、LocaleName、用户语言列表和 Culture。每类设置提供 `read`、`write`、`verify`、`restore StoredValue`；adapter 不拥有状态提交、日志或事务顺序。

PowerShell/注册表/tzutil 调用必须使用参数化输入和明确编码，不拼接未经校验的用户字符串。只有浏览器策略的组织管理/访问拒绝错误可映射为 `PolicyManagedOrDenied`；未知错误保持 fatal。

外部网络配置 adapter 不存在。DNS、代理和 IP 插件保持只读，测试不得触碰真实 VPN、路由、网卡、hosts、DoH 或 DNS 配置。

## CLI contract

```text
cc-fix check [--region us|eu|jp|sg] [--json]
cc-fix persist on [--region us|eu|jp|sg] [--level standard|deep] [--deep] [--json]
cc-fix persist off [--json]
cc-fix persist recover [--json]
cc-fix persist status [--json]
cc-fix region list [--json]
cc-fix region status [--json]
cc-fix region set <us|eu|jp|sg> [--json]
cc-fix run [--region us|eu|jp|sg] -- <command> [args...]
cc-fix proxy check [--json]
```

`--deep` 等价于 `--level deep`；同时提供矛盾参数为 invalid input。保护中不带 level 的 on 保持当前强度；只有显式 `--level standard` 才从 deep 降级。CLI 不弹交互确认，显式参数即授权。

CLI 稳定退出码：

| Code | Meaning |
|---:|---|
| 0 | healthy success 或 no-op |
| 2 | protection target 已提交，但 health=degraded |
| 10 | 非法参数、地区或冲突参数 |
| 20 | 活事务/活锁导致 busy |
| 21 | recovery_required，拒绝新转换 |
| 22 | 操作失败但补偿已验证，旧 target 保持 |
| 23 | 操作失败且补偿/恢复不完整 |
| 24 | 状态、备份或 schema 校验失败 |
| 30 | 启动/前置组件/内部不可分类错误 |

JSON 输出必须包含 schemaVersion、requested target、committed target、preferred/active/resolved region、health、transaction summary、step counts、noOp/rolledBack 和稳定 error id。人类输出不得与 JSON 语义分叉。

## GUI and local service contract

- 日常页提供开启标准、开启深度与偏好地区选择；标准页提供检查并修复、升级深度、调整地区/目标和还原；深度页提供检查并修复、降为标准、调整地区/目标和还原。
- 状态栏独立显示 mode、health、preferred/active region 和未完成 transaction。
- “调整保护”一次提交 level + region，显示旧 target→新 target、实际影响项和深度提示。
- 首次标准保护显示一次影响确认；每次进入/升级 deep 都确认；重复对齐、降级和还原直接显示步骤流。
- 修复后仅在 resolved target 相同且无未提交事务时计算 before/after；换区建立新评分基线。
- VPN/DNS/路由结果显示“仅提醒，需要按自身网络环境处理”，没有自动修复入口。

本地服务只绑定 `127.0.0.1`。壳生成随机端口、高熵一次性 token 和 session id；引导请求兑换 `HttpOnly; SameSite=Strict` cookie 后移除 URL token。所有 HTTP/API/SSE 校验 session、Host、Origin 和 loopback 来源。修改端点使用 CSRF 防护并维持全局单修改事务；触发端点立即返回 202，busy 返回 409。

## Desktop shell contract

1. 获取当前用户单实例；第二次启动聚焦已有窗口。
2. 创建 desktop session，启动安装目录内私有 Node 24 与核心 GUI entry。
3. 等待含 session id 的认证就绪握手，再创建 WebView 主窗口。
4. 服务失败显示原生错误页，包含分类、脱敏日志位置、重试、复制诊断和恢复入口；不退回系统浏览器。
5. 正常关窗先优雅停止服务，超时后只终止可验证的私有子进程。
6. 修改事务中首次关窗阻止退出；强制退出前确认 journal 已 flush，下一次启动进入恢复页。
7. WebView 禁止任意远程导航和通用 shell/文件系统能力。
8. 默认不驻留托盘，不安装长期后台服务。

诊断日志位于 `%LOCALAPPDATA%\CC-Fix\logs`，滚动、脱敏，不记录环境变量值、IP、token 或恢复数据。操作历史与恢复数据继续位于 `%APPDATA%\cc-fix`。

## Privileged helper contract

助手只在普通权限写浏览器策略被拒且用户确认后启动。请求必须绑定当前 transaction/session，使用固定 schema 和策略槽 allowlist，只接受预期类型和值；不得接收命令、脚本、任意注册表路径或文件路径。助手写入后退出，普通权限核心负责读回验证。取消 UAC 视为策略拒绝，可按 ADR 0006 以 degraded 提交，不提升整个 GUI 或 Node 服务。

## Core bundle and private runtime

- release bundle 使用 Node 24 target、ESM、single file、`noExternal`，不得在运行时从安装目录外解析 npm 依赖。
- 修正 `src/run/injector.ts` 的 ESM 动态 `require`；bundle smoke 必须覆盖 run/GUI/CLI entry。
- private runtime 来自固定官方 Node x64 zip，构建前验证官方签名/哈希；只随 CC-Fix 使用，不加入系统 PATH。
- CLI launcher 调用相对安装目录的 private `node.exe` 与核心 bundle，不依赖当前工作目录或系统 Node。
- desktop、CLI、installer preflight 使用同一个版本/状态核心，不复制领域实现。

## Installer contract

### Identity and layout

- Inno Setup 6.7.x，`PrivilegesRequired=lowest`，当前用户安装。
- 稳定 AppId 和固定 `%LOCALAPPDATA%\Programs\CC-Fix`；每个用户一个正式活动版本。
- 受管载荷：桌面壳、private Node、核心 bundle、CLI launcher、helper、许可证、WebView2 offline installer、卸载器。
- 开始菜单始终创建；桌面快捷方式默认创建可取消；CLI PATH 默认加入可取消。

### PATH and process ownership

PATH 仅维护规范化 `%LOCALAPPDATA%\Programs\CC-Fix\bin` 段，大小写不敏感去重；修复不重复，卸载只移除自身段并广播环境变化。只识别 CC-Fix 壳与经安装 manifest 验证的 private service，不按 `node.exe` 名称杀进程。

### WebView2

检测 Evergreen runtime；缺失时使用内嵌 Microsoft x64 offline installer，安装后重新探测。失败终止安装。若待重启或仍不可用，不自动重启、不启动 CC-Fix；交互显示说明，静默返回稳定结果。

### Install, upgrade and repair

- fresh install 不读取/改写用户恢复数据；保留状态重装只校验并接续已有数据。
- 更高版本先通过状态/事务 preflight，再在固定目录原位升级；保留完整旧受管载荷直到新载荷验证成功。
- 同版本进入 repair：覆盖并校验受管文件，复用快捷方式/PATH 选择，不改变状态、备份、偏好、history。
- 旧版本默认拒绝覆盖新版本。数据 schema 不兼容时旧应用只允许诊断，不改写新状态。
- 安装/升级失败恢复完整旧应用和注册；回退失败阻止启动混合版本。

### Uninstall

- daily + 无事务：普通卸载受管程序；用户数据默认保留，可显式选择安全删除。
- standard/deep：默认先调用完整还原，验证 daily 后卸载；恢复失败停止卸载。
- recovery_required/未完成事务：阻止普通卸载，引导恢复或 repair。
- 明确“仅删除程序”逃生路径可保留当前系统设置，但必须保留全部 recovery data 并输出重装说明。
- 删除用户数据只在 daily、无事务且用户显式勾选时可用；解析绝对根目录、拒绝重解析点、只删 allowlist，不使用宽泛通配符。

### Installer result codes

安装器/卸载器必须同时写稳定 machine result id 和进程退出码：

| Exit | Result id | Meaning |
|---:|---|---|
| 0 | `SUCCESS` | 成功 |
| 3010 | `SUCCESS_REBOOT_REQUIRED` | 程序文件已安装，需重启后才能启动 |
| 2 | `USER_CANCELLED` | 用户取消 |
| 40 | `TRANSACTION_BLOCKED` | 活动/未完成事务阻止操作 |
| 41 | `DOWNGRADE_REFUSED` | 旧版本覆盖被拒 |
| 42 | `RESTORE_FAILED` | 卸载前完整还原失败 |
| 43 | `PREREQUISITE_FAILED` | WebView2 或其他前置失败 |
| 44 | `FILE_ROLLBACK_FAILED` | 受管文件回退失败，禁止混合版本启动 |
| 45 | `UNSAFE_DATA_DELETE_REFUSED` | 用户数据删除边界验证失败 |

实现必须验证 Inno 对自定义退出码的传播；如果引擎限制导致映射变化，只可调整数值，result id 与语义不得变化，并同步文档/测试。

## Release pipeline

1. 验证 clean tag、版本单一事实源、lockfile、固定工具链和来源哈希。
2. typecheck、unit、coverage、integration、GUI、Rust、bundle smoke、security/license/secret scans。
3. 构建未签名可重复载荷；正式版执行第二独立构建并比较。
4. 验证官方 Node/WebView2 签名和 SHA-256，组装 installer。
5. 证书可用时签 CC-Fix 自有 PE，使用 SHA-256 + RFC3161 timestamp，并验证发布者/时间戳；无证书记录 unsigned。
6. 生成版本化 installer、`SHA256SUMS.txt`、CycloneDX JSON、`THIRD-PARTY-NOTICES`、`build-info.json`。
7. 执行 Windows 客户端矩阵并收集脱敏证据。
8. 生成并验证 GitHub artifact attestation。
9. 创建 draft Release、上传全部资产、运行 asset verification、记录人工批准后公开 immutable Release。
10. 使用 npm OIDC Trusted Publishing 发布相同版本/提交/tarball；RC→`next`，stable→`latest`。

同一版本资产禁止替换。严重问题通过 Release 警示、npm deprecate 和新版本修正；仅凭据泄露、恶意载荷或法律要求可删除资产，并保留公开事件说明。

## Testing strategy

### Levels

- **Unit**：纯领域、地区解析、schema、迁移、错误分类、计划差异、退出码映射。
- **Fault-injected integration**：每个 journal 边界前后崩溃、写失败、读回不一致、补偿失败、损坏 current/valid prev、死锁接管。
- **Platform integration**：临时 HKCU/用户环境或隔离 Windows fixture 上验证 PowerShell/registry/tzutil 编解码和 StoredValue 精确恢复。
- **CLI integration**：真实 bundle 进程、JSON schema、退出码、四地区与三态矩阵。
- **GUI/API E2E**：认证、Host/Origin/CSRF、SSE、busy、目标调整、recheck、恢复页与外部网络只读提示。
- **Rust/desktop integration**：单实例、端口竞争、就绪握手、子进程崩溃、关窗、强退安全边界、诊断脱敏。
- **Installer lifecycle**：干净客户端 VM 执行 fresh/repair/upgrade/uninstall/rollback/WebView2 present+absent/offline。
- **Release verification**：hash、signature、SBOM、license、attestation、版本/提交一致性和 npm tarball install smoke。

全局 coverage 最低为 lines/statements/functions 80%、branches 75%；`src/domain`、`src/state`、`src/persist` 最低 branches 90%，且 ADR 0004–0010 的每条 testable invariant 必须有命名测试。覆盖率不能替代场景验收。

### Windows acceptance matrix

| Scenario | Win11 25H2 | Win11 24H2 | Win11 26H1 | Win10 22H2 |
|---|---|---|---|---|
| RC full lifecycle | Required | Core subset | — | Legacy subset |
| Stable full lifecycle | Required | Install/upgrade/core/uninstall | Manual smoke | Legacy install/core/uninstall |
| No system Node + offline | Required | Required stable | Manual stable | Required stable |
| WebView2 absent/present | Both | At least absent stable | Present smoke | Both stable |
| standard/deep + four regions | Full | standard + one non-US | standard + US smoke | standard + US |
| repair/rollback/blocked transaction | Full | upgrade/repair stable | — | uninstall/block stable |

所有真实 Windows 测试在执行前后导出受影响系统信号与网络配置摘要；测试必须证明恢复精确、状态一致且 VPN/路由/网卡/DNS 未变化。敏感值在上传证据前脱敏。

## Code style

- TypeScript strict、ESM、显式联合类型；领域错误使用稳定 `code`，不用消息文本控制流程。
- 纯领域计划与 Windows I/O 分离；事务层不得直接调用 `child_process`。
- 每个有副作用的方法接收已校验结构体，不接受未经解析的 region/registry/path string。
- 状态 switch 必须穷尽，未知 schema/状态 fail closed。

```ts
export async function applyStep<T>(
  step: PlannedStep<T>,
  adapter: AuthorityAdapter<T>,
  journal: TransactionJournal,
): Promise<VerifiedStep<T>> {
  await journal.markApplying(step.id);
  await adapter.write(step.desired);
  const observed = await adapter.read();
  if (!adapter.equals(observed, step.desired)) {
    throw new PersistError("READBACK_MISMATCH", step.id);
  }
  await journal.markVerified(step.id, observed);
  return { ...step, observed, status: "verified" };
}
```

- 测试名描述领域不变量和失败点；不删除或放宽失败测试来通过门禁。
- PowerShell 使用 `-LiteralPath`、结构化参数和明确 UTF-8；文件删除/移动前验证解析后的绝对边界与 reparse point。

## Migration and rollout sequence

1. **Stabilize contracts**：纳入 CONTEXT/ADR/spec，建立版本和测试命令单一入口。
2. **Build state foundation**：在不切换生产 flow 的情况下实现 schema、durable file、migration、lock、journal 与 fault tests。
3. **Introduce transaction engine**：通过开发期 v2 开关接入 standard/deep/on/off/recover；与旧 flow 做只读对照，不双写系统设置。
4. **Switch interfaces**：CLI、GUI、history、detection 全部改用 v2 application service；移除“备份存在=secure”和非法地区回落。
5. **Remove legacy writes**：迁移/恢复矩阵通过后删除旧 flow 的写入口，保留明确版本化的 legacy backup reader。
6. **Product shell**：接入认证本地服务、Tauri 壳和 helper；核心仍可通过 CLI 独立验证。
7. **Installer and release**：构建 private runtime payload、Inno 生命周期、CI 和证据包。
8. **RC hardening**：执行全部 Windows 矩阵、修正文档、发布 `0.2.0-rc.N`；代码变化递增 RC。
9. **Stable promotion**：最后 RC 后只变版本元数据/说明，双构建与独立批准后发布 `0.2.0`。

## Rollback strategy

- 每个实施批次在主分支保持 typecheck/test/build 通过；高风险 state/transaction 先以新模块和测试落地。
- v2 接入期间只能选择旧 engine 或新 engine 执行，禁止双写；发现问题可切回旧 engine，但已经生成 v2 state/journal 时旧 engine只能只读并引导恢复，不能覆盖。
- schema migration 总是保留旧文件和校验副本；回滚代码不得降级写入未知新 schema。
- 桌面壳失败不影响独立 CLI 诊断/恢复入口。
- installer 升级失败恢复完整旧受管载荷；回退失败阻止启动混合版本。
- 已公开版本不回滚 tag/资产；问题版本 deprecate，并通过新 patch 修正。

## Boundaries

### Always do

- 写前 journal、写后权威读回、最后原子提交。
- 保留不可覆盖原始日常快照，精确表达 missing/null/empty。
- 对所有 CLI/GUI 输入重新校验地区、level、路径和策略槽。
- 每个任务运行针对测试；每个 checkpoint 运行 typecheck、全量测试和相关构建。
- 保留用户未提交工作和 `.wayfinder` 证据；任何清理另行授权。
- 同步更新规格、CONTEXT、ADR、README、CLI help 和 release docs。

### Ask first

- 改变 ADR 0004–0010 的产品语义或本规格的公开契约。
- 新增会修改外部网络配置的能力、长期后台服务或新的提升权限范围。
- 改变稳定 AppId、安装根目录、用户数据根目录、版本/渠道关系或发布资产格式。
- 删除/迁移用户恢复数据、旧备份或用户现有 `.wayfinder` 材料。
- 增加许可证义务不清或会进入发布载荷的新依赖。

### Never do

- 以备份存在推断保护模式，或把命令成功当作步骤验证成功。
- 用当前保护态补齐缺失的日常原值。
- 静默把非法地区回落到 us，或跨地区比较 recheck 分数。
- 自动修改 VPN、路由器、路由表、网卡、hosts、DoH 或 DNS。
- 提升整个 GUI/Node 服务，接受任意 helper 命令，或按通用 `node.exe` 杀进程。
- 在非 daily/有事务时删除恢复数据，跟随 reparse point，或越出精确数据根目录。
- 上传本地开发构建为公开资产，覆盖已发布版本，或在测试失败时靠重跑放行。
- 记录 token、IP、环境变量值、VPN/DNS 凭据或恢复数据到诊断日志。

## Project Definition of Done

一个实施任务只有在以下条件全部满足时才可勾选：

1. 任务 acceptance criteria 有自动或人工证据，且没有通过放宽契约实现。
2. 新/改行为有对应层级测试；故障路径与恢复路径同等覆盖。
3. `pnpm typecheck` 和任务相关测试通过；checkpoint 还需全量测试与相关 build 通过。
4. 未引入未固定运行时依赖、秘密、真实网络配置修改或用户数据破坏。
5. 领域术语、JSON schema、退出码和用户文档保持一致。
6. 变更可回退，schema/安装器变化写明旧版本兼容边界。
7. 代码评审确认文件所有权、权限边界、日志脱敏和测试证据。

## Success criteria

- `cc-fix --version`、package、installer、文件名、tag、Release 和 npm 报告同一个 0.2 版本与提交。
- 无系统 Node、断网、WebView2 缺失的干净 Windows 客户端可安装并受控启动，或返回明确待重启状态。
- CLI 和桌面 GUI 都能完成 standard/deep、四地区、换区、降级、重复对齐、off 和 crash recovery。
- 任一写入/读回/进程中止故障不会错误提交新 target；恢复可重试并精确还原 missing/null/empty。
- 状态、检测、复测和 history 的 mode/health/region/transaction 一致。
- install/upgrade/repair/uninstall 不破坏恢复数据；失败不留下可启动的混合版本。
- VPN、路由、网卡、hosts、DoH 和 DNS 在所有产品及安装生命周期中保持不变。
- 主/兼容/新设备/遗留 Windows 矩阵达到 ADR 0010 门槛，P0/P1 为零。
- 公开 Release 包含安装器、SHA-256、SBOM、第三方声明、build-info 和已验证 attestation；有证书时签名链有效，无证书时披露明确。
- 最后 RC 仅通过允许差异晋级 `0.2.0`，npm 与 GitHub 同版本同提交。

## Open questions

None。若实现发现必须改变产品语义，停止对应任务并先更新 Wayfinder/ADR/本规格，不在代码中隐式决定。

