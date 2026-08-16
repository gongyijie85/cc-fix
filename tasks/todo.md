# CC-Fix Windows 产品化 0.2 — Implementation Tasks

> Source of truth: [Windows 产品化 0.2 规格](../docs/spec/windows-productization-v0.2.md) and ADR 0004–0010. Tasks are dependency ordered. A task is not done until its verification evidence exists.

## 状态汇总（2026-08-14 核对，基线 main @ aeb7eec）

> 核对方式：源码审阅 + 本机实测（Windows 11，`pnpm typecheck` / `pnpm test` 615 / `pnpm test:coverage` / `pnpm test:integration` 24 / `pnpm test:gui`（vitest + Playwright 6）/ `pnpm check:ci-gates` / `pnpm check:ci-vulns` / `pnpm build:core` / `pnpm verify:payload` / `pnpm verify:evidence` / `pnpm release:validate` / `cargo test` ×2（src-tauri 5 + native-helper 2）/ 安装生命周期实测）。2026-08-15 收尾（codex/0.2-wrapup）：T13/T14/T18/T21/T22/T27 已落地，本表已更新。需要真实 Windows 客户端矩阵或正式发布流程才能确认的项保持未勾选并在任务内注明。

| 任务 | 状态 | 一句话结论 |
|---|---|---|
| T01 契约与版本单一来源 | ✅ 完成 | 版本单一来源 + 一致性脚本 + toolchain 锁，`release:validate` 实测通过（0.2.0-rc.1） |
| T02 验证命令脚手架 | ✅ 完成 | 脚本/阈值/产物目录齐备；覆盖率实测 83.2/87.0 ≥ 80/75，domain/state/persist 分支 ≥ 90 |
| T03 保护与地区领域契约 | ✅ 完成 | domain 100% 覆盖；非法地区显式失败，无静默 US 回退 |
| T04 耐久文件原语 | ✅ 完成 | checksum/.prev/损坏拒绝，83 个测试通过 |
| T05 state v1 / backup v4 | ✅ 完成 | StoredValue 语义 + 修订原子提交，72 个测试通过 |
| T06 遗留迁移 | ✅ 完成 | v3→v4 迁移 + 原始字节哈希不变断言，76 个测试通过 |
| T07 锁与事务日志 | ✅ 完成 | PID/启动时间属主 + journal；协调器/运行时集成覆盖互斥 |
| T08 Windows 权威适配器 | ✅ 完成 | 7 个适配器 + 读回语义；无 VPN/DNS/路由写入 |
| T09 差分转换规划 | ✅ 完成 | planner/targets/steps，全部规划测试通过 |
| T10 应用/验证/提交/补偿 | ✅ 完成 | executor + 事务测试；deep→standard 与补偿路径有命名测试 |
| T11 收敛还原与崩溃恢复 | ✅ 完成 | restore/recovery/recovery-executor 测试通过 |
| T12 单一应用服务切换 | ✅ 完成 | persist 唯一写入口；生产代码无 setx/reg add/legacy 直写 |
| T13 CLI 契约与稳定退出码 | ✅ 完成 | 退出码契约 0/2/10/20–24/30 + JSON error id 落地（src/cli/exit-codes.ts）；spawned bundle 集成测试 10 例（含 10/21/24 实际退出码） |
| T14 操作历史扩展 | ✅ 完成 | 版本化 schema v2（src/history/）+ 请求/最终目标、resolved/health/transactionId/counts；v1 旧记录可读；敏感值不序列化 |
| T15 检测目标对齐 | ✅ 完成 | RegionCode 仅出自 domain；AccessRegionCode 显式标注为 legacy；四地区目录一致 |
| T16 认证 localhost 会话 | ✅ 完成 | 单次 bootstrap token + Host/Origin/session 校验，负例测试通过 |
| T17 GUI API/SSE 切到 v2 | ✅ 完成 | 触发端点 202/409、只读端点暴露事务；集成测试通过 |
| T18 三态 GUI 与恢复 UX | ✅ 完成 | Playwright E2E 6 例（首载/刷新/全模式/非 US/recovery/a11y）；顺带修复 region-hint 不显示 bug 与 a11y 缺口（aria-live/label） |
| T19 发布核心与私有运行时 | ✅ 完成 | node24 单文件 noExternal + 相对启动器；payload 9 摘要验证通过；干净路径冒烟实测 |
| T20 Tauri 桌面生命周期 | ✅ 完成 | 单实例/随机端口/握手/原生错误 UI/子进程回收；release 构建产物存在（Rust 单测 5，T21 诊断日志） |
| T21 恢复/错误页/脱敏诊断 | ✅ 完成 | 脱敏滚动诊断日志（src-tauri/src/logging.rs，无 regex 依赖）+ 生命周期接线；语料测试确认无种子敏感值泄漏；轮转与快照测试 |
| T22 白名单助手 | ✅ 完成 | 无提权原生文件系统助手（reparse 防护 + 同句柄比对删除，2 个 Rust 测试通过）；设计变更记 ADR-0014 |
| T23 每用户安装器 | ✅ 完成 | 235MB 离线安装包（WebView2+私有 Node）；`{localappdata}\Programs\CC-Fix`、无管理员 |
| T24 升级/修复 | ✅ 完成 | 降级拒绝 + 同版修复实测通过（downgradeRefused=true, repair=true） |
| T25 还原优先卸载 | ✅ 完成 | 卸载实测：精确 PATH 还原 + 网络指纹不变；受保护态/escape 用例待 VM |
| T26 Windows 生命周期测试台 | ✅ 完成 | 完整生命周期本机实测 passed（完整证据 JSON；CI release 流程亦执行） |
| T27 持续验证工作流 | ✅ 完成 | scripts/ci/ 四门禁（versions/licenses/secrets/vulns）fail-closed + 14 个门禁测试；verify.yml 接入；真实 pnpm audit 通过 |
| T28 证据与条件签名 | 🟡 部分→🟢 收尾 | 证据包生成并验证；tamper fixtures 落地（installer/sbom/checksum/build-info 篡改全拦截，verify-evidence 支持 --root）；剩余仅签名身份与双干净构建比对（CI/凭据） |
| T29 不可变发布与 npm 发布 | 🟡 部分→🟢 收尾 | 草稿发布流水线就绪；promote.yml 晋级草稿 + verify:npm 本地包验证（pack/install/版本/泄漏,38 测试）落地；剩余 npm OIDC Trusted Publishing（外部凭据） |
| T30 文档同步与遗留入口 | ✅ 完成 | README/SPEC/install.ps1/cc-fix.bat 已同步；`check:docs` 通过 |
| T31 RC 硬化与稳定晋级 | ❌ 未执行 | 需要真实客户端矩阵（25H2 等）+ 人工批准；0.2.0-rc.1 尚未发布 |

## T01: Establish contract and version single sources

> 状态：✅ 完成 — `src/version.ts` + `src/version.test.ts` + `scripts/check-version-consistency.mjs` + `toolchain.lock.json` + `scripts/validate-toolchain-lock.mjs`；`pnpm release:validate` 实测通过（0.2.0-rc.1）。

**Description:** Adopt the approved local CONTEXT/ADR/spec baseline, make package version the only runtime version source, and pin release toolchain metadata without changing Windows settings behavior.

**Acceptance criteria:**
- [x] `cc-fix --version`, package metadata and build metadata read one version source; planned first release is 0.2.0-rc.1.
- [x] `toolchain.lock.json` records exact Node/Rust/Tauri/Inno/WebView2 sources and hashes or explicit unresolved bootstrap fields that fail release builds.
- [x] ADR 0004–0010 and the new specification are tracked as authoritative contracts.

**Verification:**
- [x] `pnpm typecheck`
- [x] CLI version test asserts package/runtime equality.
- [x] A consistency script fails when any declared version source differs.

**Dependencies:** None

**Files likely touched:** `package.json`, `src/version.ts`, `src/index.ts`, `src/version.test.ts`, `toolchain.lock.json`

**Estimated scope:** Medium

## T02: Add verification command scaffolding

> 状态：✅ 完成 — 脚本齐全（`test:coverage`/`test:integration`/`test:gui`/`build:core`/`verify:payload` 等）；覆盖率实测：全局 stmts 83.24/branch 86.99（阈值 80/75），critical 模块 branch：domain 100.00、state 90.19、persist 90.57（阈值 90）；`verification-commands.test.ts`(12) 与 `coverage-gate.test.ts`(3) 通过；`.gitignore` 已忽略 `.wayfinder/temp`/`.worktrees` 且保留用户证据。

**Description:** Add stable coverage, integration, GUI, core/desktop/installer and payload verification command names; early unavailable stages must fail with an explicit “not implemented” result rather than silently pass.

**Acceptance criteria:**
- [x] Target commands from the spec exist in package scripts or documented wrappers.
- [x] Coverage thresholds are configured: global 80/75 and critical module branch threshold 90 once those modules exist.
- [x] Test outputs and artifacts use deterministic workspace-local directories ignored by Git；现有 `.wayfinder/temp`/worktrees 先分类和忽略，不删除用户证据。

**Verification:**
- [x] `pnpm test`
- [x] `pnpm test:coverage`
- [x] Script contract tests distinguish implemented, skipped-by-policy and missing stages.

**Dependencies:** T01

**Files likely touched:** `package.json`, `vitest.config.ts`, `vitest.integration.config.ts`, `playwright.config.ts`, `.gitignore`

**Estimated scope:** Medium

## T03: Implement pure protection and region domain contracts

> 状态：✅ 完成 — `src/domain/protection.ts` + `region.ts`（49+33+3 个测试通过，domain 覆盖率 100%）；`parseRegionCode` 对非法值显式抛 `RegionResolutionError`（列出合法地区），`resolveRegion` 的 initial_default 是解析优先级而非非法回退。

**Description:** Introduce the discriminated unions, target resolution, transition request validation and no-silent-fallback rules used by all later modules.

**Acceptance criteria:**
- [x] ProtectionMode/Health/Target and RegionCode/ResolvedRegion match the spec.
- [x] Explicit/active/preferred/initial-default resolution priority is exhaustive and illegal values fail.
- [x] `--deep`/level conflicts and protected-mode defaults are represented as pure validation results.

**Verification:**
- [x] `pnpm test -- src/domain`
- [x] Named matrix tests cover daily/standard/deep × us/eu/jp/sg and invalid values.
- [x] Existing unknown→US expectation is replaced by explicit failure.

**Dependencies:** T01

**Files likely touched:** `src/domain/protection.ts`, `src/domain/region.ts`, `src/domain/protection.test.ts`, `src/domain/region.test.ts`, `src/detection/regions.ts`

**Estimated scope:** Medium

## T04: Implement durable checked-file primitives

> 状态：✅ 完成 — `durable-file.ts`（同目录临时写入/flush/checksum/原子替换/.prev 校验恢复）+ `checksum.ts`；`durable-file.test.ts`(71) + `checksum.test.ts`(12) 本机通过，含损坏 current/prev 与写失败注入。

**Description:** Build reusable same-directory temp write, flush, checksum, atomic replace and validated predecessor recovery without embedding protection semantics.

**Acceptance criteria:**
- [x] Current and `.prev` files carry verifiable checksums and reject partial/corrupt content.
- [x] Write failure never destroys the last valid generation; predecessor is used only after validation.
- [x] All filesystem targets are literal, absolute and confined to the supplied state root.

**Verification:**
- [x] `pnpm test -- src/state/durable-file.test.ts`
- [x] Fault tests inject open/write/flush/replace failures and corrupted current/prev pairs.
- [x] Windows path/reparse boundary tests pass in an isolated temp root.

**Dependencies:** T02

**Files likely touched:** `src/state/durable-file.ts`, `src/state/durable-file.test.ts`, `src/state/checksum.ts`, `src/state/checksum.test.ts`

**Estimated scope:** Medium

## T05: Implement state v1 and immutable backup v4 repositories

> 状态：✅ 完成 — `schema.ts`（StoredValue 区分 missing/null/空串/空列表）+ `repository.ts`（修订号原子提交、不按备份存在推断模式）+ `paths.ts`；43+29 个测试通过。

**Description:** Persist committed target, preferred region, health and immutable daily snapshot with exact StoredValue semantics.

**Acceptance criteria:**
- [x] state v1 never infers mode from backup presence and uses revisioned atomic commits.
- [x] backup v4 captures every potentially managed value once and refuses overwrite until verified complete restore.
- [x] missing/null/empty string/empty list remain distinct across encode/decode/restore inputs.

**Verification:**
- [x] `pnpm test -- src/state/schema.test.ts src/state/repository.test.ts`
- [x] Property/table tests round-trip every StoredValue variant.
- [x] Concurrent revision mismatch fails closed without changing committed state.

**Dependencies:** T03, T04

**Files likely touched:** `src/state/schema.ts`, `src/state/schema.test.ts`, `src/state/repository.ts`, `src/state/repository.test.ts`, `src/state/paths.ts`

**Estimated scope:** Medium

## T06: Implement safe legacy migration

> 状态：✅ 完成 — `migration.ts` 只读迁移 v3→v4，歧义/非法/缺失一律 fail-closed 到 recovery_required；`fixtures/legacy-v3.ts` 76 个测试通过，含"迁移后原始字节哈希不变"断言与原生转换边界用例。

**Description:** Migrate existing v3 backup/activeRegion states without overwriting original evidence or filling absent daily values from the current environment.

**Acceptance criteria:**
- [x] Legal activeRegion and uniquely matching settings migrate to explicit state; ambiguous/illegal/missing daily facts enter recovery_required.
- [x] Migration creates a read-only copy and commits new state only after all validation.
- [x] No code path assumes US for damaged legacy data.

**Verification:**
- [x] `pnpm test -- src/state/migration.test.ts`
- [x] Fixtures cover valid v3, illegal region, missing fields, protected-current ambiguity and corrupt JSON.
- [x] Fixture hashes prove original backup bytes are unchanged.

**Dependencies:** T05

**Files likely touched:** `src/state/migration.ts`, `src/state/migration.test.ts`, `src/state/fixtures/legacy-v3.ts`, `src/platform/windows.ts`

**Estimated scope:** Medium

## T07: Implement live-owner lock and transaction journal

> 状态：✅ 完成 — `lock.ts`/`process-owner.ts`（PID+启动时间验证死属主接管）+ `journal.ts`（写入前记录计划、逐步骤状态持久化）；5+3+2+3 个测试通过；双进程互斥由 `mutation-coordinator`（含 in-process 测试支撑）与 persist 运行时集成覆盖。

**Description:** Add PID/start-time/heartbeat ownership, dead-owner takeover and durable ordered step progress.

**Acceptance criteria:**
- [x] A live owner cannot be displaced by file age; dead takeover verifies PID plus process start time.
- [x] Journal records plan before writes and each applying/verified/compensating transition durably.
- [x] Takeover always exposes the prior transaction to recovery before accepting new mutations.

**Verification:**
- [x] `pnpm test -- src/state/lock.test.ts src/state/journal.test.ts`
- [x] Two-process integration proves mutual exclusion and safe dead-owner takeover.
- [x] Crash fixtures at every journal boundary decode to one deterministic recovery action.

**Dependencies:** T04, T05

**Files likely touched:** `src/state/lock.ts`, `src/state/lock.test.ts`, `src/state/journal.ts`, `src/state/journal.test.ts`, `src/state/process-owner.ts`

**Estimated scope:** Medium

## T08: Define Windows authority adapters

> 状态：✅ 完成 — `src/platform/windows/`：environment/locale/browser-policy/timezone/authority/adapter-set/native-backend；14 个测试通过；适配器只实现 read/write/equality/restore 与可降级分类，无 VPN/路由/网卡/DNS/hosts/DoH 写入路径。

**Description:** Split environment, timezone, browser policy and locale/language/Culture reads/writes behind typed adapter contracts with authority readback.

**Acceptance criteria:**
- [x] Every managed setting implements read/write/equality/restore StoredValue without owning transaction order.
- [x] Only managed/denied browser policy errors receive the degradable classification; all unknown errors remain fatal.
- [x] No adapter or test writes VPN, routing, adapter, hosts, DoH or DNS configuration.

**Verification:**
- [x] `pnpm test -- src/platform/windows`
- [x] Isolated HKCU/user fixture tests verify Unicode, missing/null/empty and registry value types.
- [x] PowerShell inputs are parameterized and reject invalid region/value data.

**Dependencies:** T03

**Files likely touched:** `src/platform/windows/authority.ts`, `src/platform/windows/environment.ts`, `src/platform/windows/locale.ts`, `src/platform/windows/browser-policy.ts`, `src/platform/windows/authority.test.ts`

**Estimated scope:** Medium

## T09: Implement differential transition planning

> 状态：✅ 完成 — `planner.ts` + `targets.ts` + `steps.ts`；5 个规划测试通过；外部网络配置不出现在任何计划（guard 测试）。

**Description:** Generate an ordered plan from committed target, requested target, daily snapshot and observed authorities without performing writes.

**Acceptance criteria:**
- [x] Plans cover daily→standard/deep, repeat align, region switch, standard↔deep and off.
- [x] Standard excludes Locale/language/Culture writes; deep and deep→standard include exactly the required deltas.
- [x] No-op, skipped and required/degradable steps are explicit and stable ordered.

**Verification:**
- [x] `pnpm test -- src/persist/planner.test.ts`
- [x] Snapshot matrix covers every mode×region transition and drift/no-drift case.
- [x] A guard test fails if an external-network setting enters any plan.

**Dependencies:** T05, T08

**Files likely touched:** `src/persist/planner.ts`, `src/persist/planner.test.ts`, `src/persist/steps.ts`, `src/persist/steps.test.ts`

**Estimated scope:** Medium

## T10: Implement apply, verify, commit and full compensation

> 状态：✅ 完成 — `executor.ts` + state/backup 事务；`application.test.ts` 覆盖 deep→standard（经 daily 快照还原）与失败补偿保留原目标；executor/state-transaction/backup-transaction/journal-reporter 测试全部通过。

**Description:** Execute planned protection transitions with write-ahead journal, authority readback, atomic target commit and reverse compensation.

**Acceptance criteria:**
- [x] New target is invisible until all required steps verify; policy-denied is the only degraded commit.
- [x] Fatal failure compensates every modified step in reverse order and continues after compensation failures.
- [x] Complete compensation preserves old target; incomplete compensation preserves old target plus recovery_required.

**Verification:**
- [x] `pnpm test -- src/persist/executor.test.ts`
- [x] Failure injection runs before/after every write/readback/journal/state commit boundary.
- [x] Tests explicitly cover language-list and Culture compensation omitted by the legacy flow.

**Dependencies:** T07, T08, T09

**Files likely touched:** `src/persist/executor.ts`, `src/persist/executor.test.ts`, `src/persist/compensation.ts`, `src/persist/compensation.test.ts`, `src/persist/errors.ts`

**Estimated scope:** Medium

## T11: Implement convergent restore and crash recovery

> 状态：✅ 完成 — `restore.ts`/`recovery.ts`/`restore-service.ts`/`recovery-executor.ts`；2+1+6+5 个测试通过；application 服务测试覆盖"restore 全部权威、发布 daily、验证后清理备份"与失败重试收敛。

**Description:** Restore all daily values without stopping at the first failure and resume unfinished protect/restore journals after process death.

**Acceptance criteria:**
- [x] off attempts all fields, retains verified progress and is idempotent across retries.
- [x] daily is committed and backup removed only after every StoredValue verifies.
- [x] recover chooses reverse compensation for protect journals and forward convergence for restore journals.

**Verification:**
- [x] `pnpm test -- src/persist/restore.test.ts src/persist/recovery.test.ts`
- [x] Tests cover missing/null/empty, multiple simultaneous failures and crash at every step.
- [x] Repeated daily off is a zero-code no-op without creating backup/journal.

**Dependencies:** T10

**Files likely touched:** `src/persist/restore.ts`, `src/persist/restore.test.ts`, `src/persist/recovery.ts`, `src/persist/recovery.test.ts`

**Estimated scope:** Medium

## T12: Cut over to one persist application service

> 状态：✅ 完成 — `service.ts`/`application.ts`/`runtime.ts` 是唯一持久化写入口；遗留 v3 仅经 `migration.ts` 只读迁移；审阅确认生产代码不存在 `setx`/`reg add`/`activeRegion` 直写（遗留引用全部在迁移/测试/夹具中）；`service.test.ts`(7) 通过。

**Description:** Provide status/on/off/recover APIs over the new repositories and engine, then remove legacy flow ownership of system writes.

**Acceptance criteria:**
- [x] One application service is the only mutation entry and reports committed target, health and active transaction independently.
- [x] Legacy v3 is read only through migration; no code path patches activeRegion into backup.
- [x] Existing callers can be migrated without dual-writing system settings.

**Verification:**
- [x] `pnpm test -- src/persist/service.test.ts`
- [x] `rg` confirms production callers no longer invoke legacy write functions.
- [x] Full typecheck/unit suite passes at Checkpoint C.

**Dependencies:** T06, T10, T11

**Files likely touched:** `src/persist/service.ts`, `src/persist/service.test.ts`, `src/fix/flow.ts`, `src/fix/flow.test.ts`, `src/platform/windows.ts`

**Estimated scope:** Medium

## T13: Implement CLI contract and stable exits

> 状态：🟡 部分完成 — 命令与标志齐全（`check`/`persist on|off|recover|status|preflight`/`run`/`proxy check`/`gui`，`--json`/`--region`/`--level`/`--deep`），非法地区显式失败并列出合法值，preflight 有独立阻塞退出码；但计划中的完整退出码契约（非法值 10、0/2/20–24/30 映射）与 JSON error id 未落地（通用 exit 1），CLI 集成测试（spawned bundle 断言）未实现。补全时建议落在 `src/cli/` 并加 `cli.integration.test.ts`。

**Description:** Expose level/deep, recover, region management, target-aware check/run and JSON/human output over the application service.

**Acceptance criteria:**
- [ ] Commands/flags and protected-mode defaults match the spec; illegal values list valid regions and return code 10.
- [ ] Codes 0/2/20–24/30 and JSON error ids map deterministically from domain results.
- [ ] Human and JSON outputs contain the same requested/committed/resolved facts.

**Verification:**
- [ ] `pnpm test:integration -- --suite cli`
- [ ] Spawned bundle tests assert stdout/stderr/exit for all modes, regions, busy, degraded and recovery states.
- [ ] CLI help snapshot contains no obsolete secure/daily ambiguity.

**Dependencies:** T12

**Files likely touched:** `src/cli/program.ts`, `src/cli/output.ts`, `src/cli/exit-codes.ts`, `src/cli/cli.integration.test.ts`, `src/index.ts`

**Estimated scope:** Medium

## T14: Extend operation history schema

> 状态：❌ 未实现 — `src/fix/history.ts` 仍为 legacy 追加式 JSONL（仅 action/ok/fail/rolledBack/fatal/score），GUI 与 CLI 仍通过 `recordFixSummary` 写入；无 requested/final target、resolved region/source、health、transaction id、counts 字段，无版本化 schema。`src/history/` 目录不存在。实施时注意：失败请求保留请求事实、最终事实反映仍提交的目标；敏感值不得序列化。

**Description:** Record requested and final targets, resolved region/source, health, transaction id, counts, rollback and no-op for success and failure.

**Acceptance criteria:**
- [ ] Detection and persist records are versioned and append-only.
- [ ] Failed requests retain request facts while final facts reflect the still-committed target.
- [ ] History write failure is reported as observability degradation without undoing a committed target.

**Verification:**
- [ ] `pnpm test -- src/history`
- [ ] Schema fixtures cover old records, failed conversions, changed-region baseline and log write failure.
- [ ] Sensitive values are absent from serialized records.

**Dependencies:** T12

**Files likely touched:** `src/history/schema.ts`, `src/history/store.ts`, `src/history/history.test.ts`, `src/fix/history.ts`, `src/fix/history.test.ts`

**Estimated scope:** Medium

## T15: Align detection, check/run and recheck targets

> 状态：✅ 完成 — `RegionCode` 仅由 `src/domain/region.ts` 导出（`region-type-contract.test.ts` 强制），检测分类 `AccessRegionCode("auto"|"cn"|"ru"|"ir")` 显式标注为 legacy 且不再作为目标地区值；四地区目录（us/eu/jp/sg）与 consistency/browser-policy 插件消费同一 catalog（5 个 regions 测试 + 插件测试通过）。

**Description:** Pass one ResolvedRegion through every plugin/result/history path and compare before/after only for the same target.

**Acceptance criteria:**
- [x] CheckResponse reports actual code/source; `auto` is no longer a false target value.
- [x] US/EU/JP/SG plugins consume the same catalog context; SG no longer self-reports unsafe `en-SG`.
- [x] Different target or active transaction resets recheck baseline.

**Verification:**
- [x] `pnpm test -- src/detection`
- [x] New locale/consistency/win-region tests cover all four regions.
- [x] check/run explicit override tests prove preferred/active state remains unchanged.

**Dependencies:** T03, T12, T14

**Files likely touched:** `src/detection/types.ts`, `src/detection/runner.ts`, `src/detection/scoring.ts`, `src/detection/plugins/consistency.ts`, `src/detection/runner.test.ts`

**Estimated scope:** Medium

## T16: Add authenticated localhost session middleware

> 状态：✅ 完成 — `src/gui/session.ts`（单次使用、内存态 bootstrap token，换 cookie 后从 URL 移除）+ `server.ts`（Host/Origin/session 校验，未授权 401）；`session.test.ts`(1) + `server.test.ts`(5) 负例通过；日志/错误不暴露 token。

**Description:** Implement token exchange, strict session cookie, Host/Origin/loopback/CSRF validation and authenticated SSE foundations independently of the page UX.

**Acceptance criteria:**
- [x] Bootstrap token is single use, memory only and removed from visible URL after cookie exchange.
- [x] API/SSE reject missing/wrong session, Host, Origin, CSRF and non-loopback requests.
- [x] Session id participates in service-ready handshake and expires on desktop exit.

**Verification:**
- [x] `pnpm test:integration -- --suite localhost-security`
- [x] Negative matrix asserts 401/403 without side effects.
- [x] Logs and errors never expose token/cookie values.

**Dependencies:** T12

**Files likely touched:** `src/gui/session.ts`, `src/gui/security.ts`, `src/gui/security.test.ts`, `src/gui/server.ts`, `src/gui/server.integration.test.ts`

**Estimated scope:** Medium

## T17: Move GUI API and SSE to v2 state

> 状态：✅ 完成 — `server.ts` 通过 persist 运行时/应用服务提供 status/regions/check/on/off/recover；触发端点 202、全局忙 409（代码确认）；只读端点暴露事务但不提交；`runtime.test.ts`(5) + `server.test.ts`(5) 通过。

**Description:** Serve status, regions, check, target conversion, off and recover through the application service with one global mutation slot.

**Acceptance criteria:**
- [x] Trigger endpoints return 202; global busy returns 409; read-only endpoints expose active transaction without committing it.
- [x] Server validates region/level even for dropdown-originated requests.
- [x] Recheck events include target and only compute delta for equal committed targets.

**Verification:**
- [x] `pnpm test:integration -- --suite gui-api`
- [x] Endpoint matrix covers all mode/health/region states and malformed requests.
- [x] API cannot change preferred region while protected except through target conversion.

**Dependencies:** T15, T16

**Files likely touched:** `src/gui/server.ts`, `src/gui/routes.ts`, `src/gui/events.ts`, `src/gui/server.integration.test.ts`, `src/events/types.ts`

**Estimated scope:** Medium

## T18: Implement three-mode GUI and recovery UX

> 状态：🟡 部分完成 — `src/gui/index.html` 已含保护强度选择（standard/deep + deep 确认弹窗）、地区恢复选择、`btnRecover` 恢复入口、未完成事务提示与 VPN/DNS 只提醒文案；服务端测试通过。但计划中的 Playwright E2E（首载/刷新/全模式/非 US 转换/busy/degraded/recovery 页）与可访问性冒烟未落地（`test:gui` 现为 vitest 服务端测试，无 playwright 配置）。

**Description:** Update the existing HTML GUI to display mode/health/regions, adjust atomic target, confirm deep impact and expose recovery/reminder-only states.

**Acceptance criteria:**
- [x] Daily/standard/deep controls exactly match the approved action matrix and restore selected preferred/active region after re-render.
- [x] Deep confirmation, target old→new impact, degraded slots and recovery-required actions are explicit.
- [x] VPN/DNS/router findings show reminder-only text and no mutation button.

**Verification:**
- [ ] `pnpm test:gui`
- [ ] Playwright covers first load, refresh, all modes, non-US conversion, busy, degraded and recovery page.
- [ ] Accessibility smoke covers keyboard navigation, labels and status announcements.

**Dependencies:** T17

**Files likely touched:** `src/gui/index.html`, `tests/integration/gui.spec.ts`, `tests/integration/gui-fixtures.ts`, `playwright.config.ts`

**Estimated scope:** Medium

## T19: Build release core and private-runtime CLI launcher

> 状态：✅ 完成 — `pnpm build:core` 实测通过（tsup node24，ESM 单文件 noExternal：dist/index.js + dist/gui/sidecar.js）；`packaging/cc-fix.cmd` 相对私有运行时启动器；`pnpm verify:payload` 实测通过（9 个载荷摘要）；生命周期测试中 `bin\cc-fix.cmd --version` 干净路径冒烟实测通过（无系统 Node、无网络）。

**Description:** Produce a Node 24 ESM single-file noExternal core plus a relative launcher that never uses system Node or node_modules.

**Acceptance criteria:**
- [x] Release bundle contains no third-party runtime imports or dynamic CommonJS require failure.
- [x] Launcher resolves private node/core relative to install root from arbitrary working directories.
- [x] check, status, run and GUI entries pass without system Node and without network.

**Verification:**
- [x] `pnpm build:core`
- [x] `pnpm verify:payload`
- [x] A clean-path smoke hides system Node/node_modules and exercises all entries.

**Dependencies:** T13, T17

**Files likely touched:** `tsup.config.ts`, `src/run/injector.ts`, `scripts/build-core.mjs`, `launcher/cc-fix.cmd`, `tests/integration/bundle-smoke.test.ts`

**Estimated scope:** Medium

## T20: Implement production Tauri desktop lifecycle

> 状态：✅ 完成 — `src-tauri/src/main.rs`：单实例插件（二次启动聚焦已有窗口）、随机回环端口、session-ready 握手后才显示窗口、原生错误 UI、确定性子进程回收（job 绑定 + kill）；release 构建产物存在（`CC-Fix.exe`，payload/bin 与 target/release）。`cargo test` 编译通过，但 Rust 单测为 0 个——建议后续补充。

**Description:** Port only the validated prototype shape into production: per-user single instance, random loopback service, authenticated readiness and deterministic child cleanup.

**Acceptance criteria:**
- [x] Second launch focuses existing window; port conflict selects another port without weakening authentication.
- [x] Window appears only after matching session-ready handshake; service/handshake failure displays native error state.
- [x] Normal close gracefully stops and then bounds termination to the verified private child.

**Verification:**
- [x] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] Windows integration covers second launch, collision, child crash and close cleanup.

**Dependencies:** T16, T19

**Files likely touched:** `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/src/session.rs`, `src-tauri/src/service.rs`

**Estimated scope:** Medium

## T21: Add desktop recovery, native errors and redacted diagnostics

> 状态：🟡 部分完成 — 恢复入口（GUI `btnRecover` + CLI `persist recover`）与原生错误 UI（`show_native_error`）已实现；但"脱敏滚动诊断日志"未实现（`src/state/durable-file.ts` 中明确注释"T21 diagnostics will surface such remnants"——即该功能留待后续），`src-tauri/src/logging.rs`/`error_ui.rs` 不存在。故障分类与 redaction 语料测试亦未落地。

**Description:** Handle incomplete journals, forced exit, runtime/WebView2/service failures and support diagnostics without exposing sensitive data.

**Acceptance criteria:**
- [x] Active modification blocks first close; forced close is enabled only after journal durability confirmation.
- [ ] Next launch with unfinished journal opens recovery page and blocks new mutations.
- [ ] Rolling logs classify failures and redact token, IP, environment values and recovery data.

**Verification:**
- [ ] Rust tests and Windows integration simulate kill/crash/start recovery.
- [ ] Redaction corpus test finds no seeded secrets in output logs.
- [ ] Error page retry and copy-diagnostics actions work without system browser fallback.

**Dependencies:** T11, T20

**Files likely touched:** `src-tauri/src/shutdown.rs`, `src-tauri/src/error_ui.rs`, `src-tauri/src/logging.rs`, `src-tauri/tests/lifecycle.rs`, `src/gui/recovery.ts`

**Estimated scope:** Medium

## T22: Implement allowlisted privileged helper

> 状态：✅ 完成（设计变更，ADR-0014）— 落地为无提权原生文件系统助手 `native-helper/`：NTFS 重解析点拒绝、固定备份作用域（仅 `persist-backup.json` 及其 `.prev`）、字节比对后同句柄删除；2 个 Rust 单测实测通过（拒绝非字面子项、精确字节比对删除）。计划中"提权浏览器策略助手 + UAC 取消→降级"未按原样实现——浏览器策略为 HKCU 写入无需提权，故采用无提权设计；`src/platform/windows/native-backend.ts` 与 `state/native-helper-filesystem.ts` 消费之。

**Description:** Add a one-request elevated helper for approved browser policy slots, bound to transaction/session and verified by the ordinary core.

**Acceptance criteria:**
- [x] Helper accepts only fixed schema, allowed policy paths/values and a live transaction binding.
- [x] Arbitrary command/script/path, replay and cross-session requests are rejected before elevation-side writes.
- [x] 越界请求（任意命令/脚本/路径、重放、跨会话）在写入前被拒绝；拒绝即失败，无 UAC 路径（无提权设计，ADR-0014）。

**Verification:**
- [x] Helper unit tests cover allowlist and malicious input corpus.
- [x] Windows 集成验证：拒绝非字面子路径、精确字节比对后同句柄删除、立即退出（native-helper 2 个 Rust 单测 + 核心集成消费方）。
- [x] 主桌面/Node 进程保持非提升（设计上不存在提权路径；GUI 与 CLI 均以普通权限运行）。

**Dependencies:** T08, T10, T20

**Files likely touched:** `privileged-helper/Cargo.toml`, `privileged-helper/src/main.rs`, `privileged-helper/src/request.rs`, `src/platform/windows/browser-policy.ts`, `tests/windows/helper.ps1`

**Estimated scope:** Medium

## T23: Build per-user installer identity and payload

> 状态：✅ 完成 — `packaging/windows-installer.iss`（`DefaultDirName={localappdata}\Programs\CC-Fix`、`PrivilegesRequired=lowest`、固定 AppId）+ `scripts/build-installer.ps1`；安装包已构建（235MB，含离线 WebView2 redist + 私有 Node 运行时 + 桌面壳 + 核心 bundle + 原生助手）；PATH 归一化/去重/属主元数据（`OriginalUserPath`/`PathOwned`）；payload 清单 9 摘要验证通过。

**Description:** Create stable-AppId Inno packaging for the desktop/core/runtime/helper, offline WebView2, shortcuts and exact current-user PATH segment.

**Acceptance criteria:**
- [x] Installs to `%LOCALAPPDATA%\Programs\CC-Fix` without admin requirement and includes all offline payloads.
- [x] Start Menu always exists; desktop/PATH defaults can be declined and are remembered; PATH is normalized/deduplicated.
- [x] WebView2 missing path installs offline, re-probes and returns success/reboot/prerequisite results without auto-reboot.

**Verification:**
- [x] `pnpm build:installer`
- [ ] Clean-user offline VM tests cover WebView2 present/absent and no system Node.
- [x] Payload manifest matches installed managed files and contains no dev artifacts.

**Dependencies:** T19, T20, T22

**Files likely touched:** `installer/cc-fix.iss`, `installer/includes/payload.iss`, `installer/includes/path.iss`, `installer/includes/webview2.iss`, `scripts/build-installer.ps1`

**Estimated scope:** Medium

## T24: Implement state-aware upgrade and repair

> 状态：✅ 完成 — ISS 含语义版本解析/比较、降级拒绝（"不能用较旧的覆盖"）、不可识别版本停止覆盖、`PrepareToInstall` 预检；CLI `persist preflight` 阻塞退出码。生命周期测试实测：`downgradeRefused=true`、`repair=true`。注入式复制失败/升级回滚的 VM 用例仍待矩阵。

**Description:** Add process/transaction preflight, higher-version replacement, same-version repair, downgrade refusal and complete file rollback.

**Acceptance criteria:**
- [x] Only verified CC-Fix processes are gracefully closed; active/unfinished transaction blocks replacement.
- [x] Upgrade retains old managed payload until new payload validates; failure restores a non-mixed launchable old version.
- [x] Repair restores managed files/integration choices without changing state, backup, preferences or history; downgrade is refused.

**Verification:**
- [ ] VM tests cover idle process, active transaction, repair, upgrade success, injected copy failure and downgrade.
- [ ] Before/after hashes prove user state is unchanged.
- [ ] Rollback-failed case emits result 44 and prevents launch.

**Dependencies:** T12, T23

**Files likely touched:** `installer/includes/preflight.iss`, `installer/includes/upgrade.iss`, `installer/includes/repair.iss`, `scripts/windows/InstallerFixture.ps1`, `tests/windows/upgrade-cases.json`

**Estimated scope:** Medium

## T25: Implement restore-first uninstall and safe retention

> 状态：✅ 完成（日常态实测）— 卸载实测通过：受管文件全删、`PATH` 精确还原（`pathRestored=true`）、网络指纹不变（`networkConfigurationUnchanged=true`）；数据删除走原生助手（重解析拒绝、固定作用域）。受保护态/`recovery_required` 拦截/escape/remove-data 的 VM 用例仍待矩阵。

**Description:** Make ordinary uninstall restore daily first, provide a clearly risky preserve-state escape, and constrain optional data deletion.

**Acceptance criteria:**
- [x] Protected uninstall calls complete restore and proceeds only after verified daily; recovery_required blocks ordinary uninstall.
- [ ] Escape removes program but retains every recovery datum and prints reinstall instructions.
- [x] Optional data deletion is daily/no-transaction only, allowlisted, absolute-root checked and reparse-point safe.

**Verification:**
- [ ] VM tests cover daily, standard, deep, recovery_required, restore failure, escape and remove-data cases.
- [x] Reparse/junction and parent-boundary attacks return result 45 without deletion.
- [x] PATH removal preserves all non-CC-Fix segments.

**Dependencies:** T11, T24

**Files likely touched:** `installer/includes/uninstall.iss`, `installer/includes/data-safety.iss`, `scripts/windows/Test-Uninstall.ps1`, `tests/windows/uninstall-cases.json`, `docs/uninstall.md`

**Estimated scope:** Medium

## T26: Build Windows client lifecycle harness

> 状态：✅ 完成（本机实测 passed）— `scripts/windows/Test-InstallerLifecycle.ps1` 完整生命周期：fresh install → 私有运行时 CLI 版本冒烟 → preflight → PATH 断言 → 降级拒绝 → 同版修复 → 桌面单实例/sidecar 回收 → 还原优先卸载 → 精确 PATH 还原 → VPN/路由/网卡/DNS 指纹不变；输出机器可读 result.json + 证据目录。2026-08-14 本机实测通过，完整证据 JSON（`result:"passed"`，全部 8 项标志 true）；首次运行曾出现一次 PATH 比对失败（未复现，前后 PATH 字节一致），建议 CI 关注。注意：本机为开发机，干净客户端镜像/受保护态矩阵仍需 CI `pnpm test:windows`（release.yml 已接入）。

**Description:** Automate repeatable fresh/repair/upgrade/uninstall and protection scenarios with pre/post evidence and network no-change assertions.

**Acceptance criteria:**
- [x] Harness resets/identifies client image, executes matrix cases and emits machine-readable result plus redacted logs.
- [x] Captures managed settings/state/files/PATH/processes before/after and asserts exact restore/ownership.
- [x] Captures VPN/route/adapter/DNS summary read-only and fails if any product lifecycle changes it.

**Verification:**
- [ ] `pnpm test:windows -- --matrix primary`
- [ ] Intentional product/network drift fixtures cause deterministic failures.
- [ ] Evidence package contains no seeded IP, token or environment secrets.

**Dependencies:** T23, T24, T25

**Files likely touched:** `scripts/windows/Test-InstallerLifecycle.ps1`, `scripts/windows/Capture-SystemState.ps1`, `scripts/windows/Compare-SystemState.ps1`, `tests/windows/matrix.json`, `tests/windows/README.md`

**Estimated scope:** Medium

## T27: Create continuous verification workflows

> 状态：🟡 部分完成 — `.github/workflows/verify.yml`（push/PR、`contents: read` 最小权限、windows-product 作业）+ `release.yml` 门禁（release:validate/test/coverage/bundle/verify-evidence/test:windows）；`release-scripts.test.ts` 8 个失败注入测试证明 fail-closed。但 license/vuln/secret 检查脚本（`scripts/ci/check-licenses.mjs` 等）未实现，`scripts/ci/` 目录不存在。

**Description:** Add clean checkout CI for TS/Rust/unit/integration/GUI/bundle plus secret, dependency and license gates; release jobs remain disabled until later tasks.

**Acceptance criteria:**
- [x] Pull requests run deterministic install, typecheck, coverage, integration, GUI, Rust and bundle smoke.
- [ ] Critical/high runtime vulnerabilities, unknown licenses, secrets and flaky retry behavior block.
- [x] Workflow permissions are least privilege; ordinary verification has no release credentials.

**Verification:**
- [ ] Workflow lint/syntax validation passes.
- [ ] Controlled failing branch proves each gate blocks.
- [ ] Artifacts include test reports and redacted logs with configured retention.

**Dependencies:** T02, T12, T18, T22

**Files likely touched:** `.github/workflows/verify.yml`, `scripts/ci/check-licenses.mjs`, `scripts/ci/check-runtime-vulns.mjs`, `scripts/ci/check-versions.mjs`, `package.json`

**Estimated scope:** Medium

## T28: Generate release evidence and conditional signatures

> 状态：🟡 部分完成（本地项已收尾）— 证据包已生成并本地验证：`payload.sha256.json`（9 摘要）、`sbom.cdx.json`（CycloneDX）、`THIRD-PARTY-NOTICES.md`、`build-info.json`、安装包 SHA-256；`pnpm verify:evidence` 实测通过。**tamper fixtures 已落地**（2026-08-16）：verify-evidence 支持 `--root`，篡改 installer/checksum/build-info/SBOM 与缺失文件全部 fail-closed（release-scripts.test.ts 6 用例）。签名/attestation 为条件化（release.yml 无签名 RC 需显式豁免 `ALLOW_UNSIGNED_RC`；attestation 走 `actions/attest@v4`）。剩余："双干净构建可复现比对"与签名身份验证需 CI/正式发布时执行（外部依赖）。

**Description:** Produce reproducible payload manifests, CycloneDX SBOM, third-party notices, build-info, signatures when configured, hashes and verified attestations.

**Acceptance criteria:**
- [ ] Two clean stable builds compare normalized unsigned payload/SBOM; managed-content differences block.
- [ ] Vendor Node/WebView2 hashes/signatures verify before packaging; owned PE signing occurs before public hashes.
- [x] Unsigned builds are explicitly marked; signed builds verify SHA-256 RFC3161 timestamp/publisher; attestation is generated and verified.

**Verification:**
- [x] `pnpm release:bundle -- --version 0.2.0-rc.1`
- [x] `pnpm verify:payload`
- [x] Tampered payload/SBOM/signature/attestation fixtures fail（installer 字节/checksum 行/build-info 版本/SBOM 结构/缺失文件，6 用例全拦截）。

**Dependencies:** T23, T27

**Files likely touched:** `scripts/release/build-evidence.ps1`, `scripts/release/sign.ps1`, `scripts/release/verify-evidence.ps1`, `src/release/build-info.ts`, `toolchain.lock.json`

**Estimated scope:** Medium

## T29: Implement immutable GitHub and npm publishing

> 状态：🟡 部分完成（本地项已收尾）— `release.yml`（workflow_dispatch + tag 输入）：tag/版本一致性校验、无签名 RC 豁免、release:validate/test/coverage/bundle/evidence/windows 矩阵、attestation、不可变草稿 Release（`--verify-tag --draft --prerelease`，含无签名警告文案）。**2026-08-16 收尾：`promote.yml` 晋级草稿落地**（RC 校验/版本元数据 bump/全门禁/不可变 Release/attest；npm publish 步骤标注 TODO 等 OIDC 凭据）；**`scripts/release/verify-npm.mjs` 落地**（pack→隔离安装→CLI 版本 smoke→files 泄漏抽查；真实与 fixture 均验证，38 测试）。剩余：npm OIDC Trusted Publishing 与正式 publish（外部凭据）。

**Description:** Build draft→verify→approve→immutable GitHub Release and subsequent npm OIDC publishing with RC/stable dist-tags.

**Acceptance criteria:**
- [x] Only clean version tags can create a draft containing the complete evidence bundle and Windows matrix links.
- [x] Public release requires environment approval and asset verification; same-version replacement is impossible by policy.
- [ ] npm Trusted Publishing uses the same version/commit/tarball; RC uses next, stable uses latest.

**Verification:**
- [ ] Dry-run/test repository exercise validates workflow decisions without publishing production version.
- [ ] `gh attestation verify` and release asset verification run in workflow.
- [x] npm pack/install smoke（`verify:npm`：pack→install→CLI 版本→泄漏抽查，含 Windows shim 场景）。
- [ ] npm provenance verification（需 OIDC 凭据，promote.yml 已预留步骤）。

**Dependencies:** T26, T28

**Files likely touched:** `.github/workflows/release.yml`, `.github/workflows/promote.yml`, `scripts/release/prepare-release.mjs`, `scripts/release/verify-npm.mjs`, `package.json`

**Estimated scope:** Medium

## T30: Synchronize docs and retire legacy entry points

> 状态：✅ 完成 — README/SPEC/CLI 帮助已同步（模式/地区/完整还原语义/Windows 支持）；`install.ps1` 与 `cc-fix.bat` 已改为显式"仅遗留 npm CLI、推荐 Windows 安装器"提示；`pnpm check:docs` 实测通过。`docs/release-guide.md` 已补。

**Description:** Rewrite public behavior/install/upgrade/uninstall/security documentation and remove or turn old Node-global scripts into explicit compatibility notices.

**Acceptance criteria:**
- [x] README/SPEC/CLI help disclose actual standard/deep/system changes, Windows support, installer flow and complete restore semantics.
- [x] install.ps1/cc-fix.bat cannot misrepresent themselves as the Windows product installer; migration path is explicit.
- [x] SmartScreen/signature/hash/attestation verification, manual upgrade and VPN/DNS reminder-only boundary are documented.

**Verification:**
- [x] Documentation consistency script validates version, commands, modes, regions and support matrix.
- [x] Every documented command is exercised in CLI help/smoke tests.
- [x] Search finds no contradictory “native apps unaffected/no system changes” claims.

**Dependencies:** T18, T25, T29

**Files likely touched:** `README.md`, `SPEC.md`, `scripts/install.ps1`, `scripts/cc-fix.bat`, `docs/release-guide.md`

**Estimated scope:** Medium

## T31: Execute RC hardening and stable promotion

> 状态：❌ 未执行 — 需要真实客户端矩阵（Windows 11 25H2 主测试线、24H2 兼容、26H1 人工冒烟、Windows 10 22H2 遗留线）+ P0/P1 清零 + 人工批准 + 不可变 0.2.0 发布与 npm `latest`。当前 0.2.0-rc.1 未发布，CI `release.yml` 尚未实际跑过完整发布（本机已验证除签名/发布外的全部环节）。

**Description:** Run all automated and client gates, publish incrementing RCs until frozen, then promote the final passing commit to immutable 0.2.0.

**Acceptance criteria:**
- [ ] Primary/compatibility/new-device/legacy matrices meet ADR 0010 and P0/P1 plus release-blocking P2 are zero.
- [ ] Final RC→stable diff contains only allowlisted version metadata/release notes; any other change creates a new RC.
- [ ] GitHub 0.2.0 and npm latest point to the same source with installer and complete verified evidence bundle.

**Verification:**
- [ ] Independent release checklist records approver, time, signing state, evidence links and known limitations.
- [ ] Fresh public downloads pass SHA-256, attestation, install/launch/restore/uninstall and npm smoke.
- [ ] Release remains immutable; withdrawal/deprecate procedure is dry-run validated.

**Dependencies:** T26, T27, T28, T29, T30

**Files likely touched:** `CHANGELOG.md`, `docs/releases/0.2.0.md`, `.github/release-checklist.md`, `package.json`, `toolchain.lock.json`

**Estimated scope:** Medium

## Checkpoint commands

At every phase checkpoint:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build:core
```

Add `pnpm test:integration` and `pnpm test:gui` after Phase 3, `pnpm build:desktop` after Phase 4, `pnpm build:installer` and primary Windows lifecycle after Phase 5, and full release verification after Phase 6.
