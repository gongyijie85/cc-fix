# Implementation Plan: CC-Fix Windows 产品化 0.2

> 状态核对：见 [`tasks/todo.md`](./todo.md) 顶部状态汇总（2026-08-14，基线 main @ aeb7eec）。Phase 0–6 主体已随 PR #28 落地；未完成/部分项：T13 退出码契约、T14 历史扩展、T18 Playwright、T21 脱敏诊断、T22 提权助手（设计变更）、T27 license/vuln 门禁、T28/T29 签名与 npm 发布、T31 未执行。

## Overview

本计划把 [Windows 产品化 0.2 规格](../docs/spec/windows-productization-v0.2.md) 分为八个可验证阶段。顺序遵循风险与依赖：状态真相和恢复能力先于界面，界面先于桌面壳，桌面壳和核心载荷先于安装器，安装生命周期通过后才建立公开发布。

目标不是把现有 CLI 直接包进 EXE，而是先替换当前“备份存在=secure”和顺序式部分写入模型；只有新事务引擎成为 CLI/GUI 的单一写入口后，才允许生成候选安装包。

## Architecture decisions

- ADR 0004：daily/standard/deep 三态，health 独立，标准为默认。
- ADR 0005：region catalog/preferred/active/resolved 分离，level×region 原子提交。
- ADR 0006：耐久 journal、读回验证、逆序补偿和收敛式完整恢复。
- ADR 0007：Tauri v2/WebView2 薄壳，按会话托管认证 localhost Node 服务。
- ADR 0008：Inno per-user 单活动版本、状态安全升级/修复/卸载。
- ADR 0009：VPN、路由、网卡和 DNS 只检测提醒，不自动修改。
- ADR 0010：0.2.0 分层发布门禁、证据包、真实 Windows 矩阵与不可变资产。

## Dependency graph

```text
T01 contracts/version ─┬─> T02 test foundation
                       └─> T03 domain/region
T02 ─────────────────────> T04 durable file
T03 + T04 ───────────────> T05 state/backup repository ─> T06 legacy migration
T04 + T05 ───────────────> T07 lock/journal
T03 ─────────────────────> T08 Windows adapter contract
T05 + T07 + T08 ─────────> T09 transition planner
T09 ─────────────────────> T10 apply/verify/compensate ─> T11 restore/recover
T06 + T10 + T11 ─────────> T12 application cutover

T12 ─┬─> T13 CLI contract
     ├─> T14 history audit
     ├─> T15 detection target alignment
     └─> T16 localhost security ─> T17 GUI API ─> T18 GUI UX

T13 + T17 ───────────────> T19 release core/private runtime
T16 + T19 ───────────────> T20 Tauri lifecycle ─> T21 recovery/error/logging
T08 + T10 + T20 ─────────> T22 privileged helper
T19 + T20 + T22 ─────────> T23 installer identity/payload
T12 + T23 ───────────────> T24 upgrade/repair
T11 + T24 ───────────────> T25 uninstall/data safety
T23 + T24 + T25 ─────────> T26 Windows lifecycle harness

T02 + T12 + T18 + T22 ──> T27 CI verification
T23 + T27 ───────────────> T28 evidence/signing
T26 + T28 ───────────────> T29 GitHub/npm publishing
T18 + T25 + T29 ─────────> T30 docs/legacy entry migration
T26 + T27 + T28 + T29 + T30 ─> T31 RC and stable promotion
```

## Phase 0: Contract and verification foundation

- [ ] T01: Establish version/toolchain single sources and adopt specification contracts.
- [ ] T02: Add coverage, integration, GUI and build command scaffolding.
- [ ] T03: Implement pure protection/region domain types and resolution rules.

### Checkpoint A

- [ ] Existing 105 tests still pass or are deliberately migrated with equivalent coverage.
- [ ] `cc-fix --version` reads the package version single source.
- [ ] Illegal regions fail explicitly; no production path silently falls back to US.
- [ ] No Windows setting behavior has changed yet.

## Phase 1: Durable state foundation

- [ ] T04: Implement checked atomic file and predecessor primitives.
- [ ] T05: Implement state v1 and immutable backup v4 repositories.
- [ ] T06: Implement safe legacy backup/state migration.
- [ ] T07: Implement live-owner lock and durable transaction journal.
- [ ] T08: Define and split Windows authority adapters with exact StoredValue semantics.

### Checkpoint B

- [ ] Fault tests cover corrupted current file, valid predecessor, flush/replace failure and concurrent access.
- [ ] Missing/null/empty string/empty list round-trip distinctly.
- [ ] Legacy migration never overwrites backup or infers missing daily values from current protected state.
- [ ] No current persist write path uses the new repository yet.

## Phase 2: Transaction engine and cutover

- [ ] T09: Implement differential transition planning for all mode/region combinations.
- [ ] T10: Implement apply, authority readback, commit and full reverse compensation.
- [ ] T11: Implement convergent off and crash recovery.
- [ ] T12: Introduce the v2 application service and remove legacy write ownership.

### Checkpoint C

- [ ] ADR 0004–0006 transition and crash invariants have named tests.
- [ ] Every injected failure leaves either the old committed target or recovery_required; never a false new target.
- [ ] Repeated off converges and restores missing/null/empty exactly.
- [ ] A single application service is the only persist mutation entry.

## Phase 3: CLI, history, detection and GUI

- [ ] T13: Implement stable CLI commands, JSON schema and exit codes.
- [ ] T14: Extend operation history with requested/resolved/final targets and health.
- [ ] T15: Align detection, check/run and recheck with resolved target regions.
- [ ] T16: Add authenticated localhost session and request validation.
- [ ] T17: Move GUI API/SSE/status/fix endpoints to the v2 application service.
- [ ] T18: Implement three-mode, health, region-adjustment and recovery UX.

### Checkpoint D

- [ ] CLI and GUI show identical mode/health/region/transaction facts.
- [ ] us/eu/jp/sg check and recheck use the same resolved target; cross-target scores are not compared.
- [ ] Host/Origin/session/CSRF negative tests pass.
- [ ] VPN/DNS/router findings expose reminder-only UX and no mutation endpoint.

## Phase 4: Release core and desktop shell

- [ ] T19: Produce Node 24 single-file noExternal core and relative private-runtime CLI launcher.
- [ ] T20: Implement production Tauri single-instance/session/service lifecycle.
- [ ] T21: Implement recovery/error pages and redacted rolling diagnostics.
- [ ] T22: Implement the transaction-bound allowlisted privileged helper.

### Checkpoint E

- [ ] Bundle runs check/persist status/run/GUI with no `node_modules` and no system Node.
- [ ] Second desktop launch focuses the first; port collision, service failure and close cleanup pass.
- [ ] Forced exit occurs only after journal durability; next launch reaches recovery UX.
- [ ] Helper rejects arbitrary paths/commands and exits after one bounded request.

## Phase 5: Installer lifecycle

- [ ] T23: Build per-user installer identity, payload, WebView2 and PATH integration.
- [ ] T24: Implement state-aware upgrade, repair, downgrade refusal and file rollback.
- [ ] T25: Implement restore-first uninstall, preserved-state escape and safe data deletion.
- [ ] T26: Build repeatable Windows client lifecycle harness and evidence capture.

### Checkpoint F

- [ ] Offline/no-system-Node fresh install works on the primary client line.
- [ ] WebView2 present/absent, repair, upgrade, rollback and stable result codes pass.
- [ ] Protected/needs-recovery uninstall boundaries preserve recovery data.
- [ ] PATH, shortcuts, AppId and managed files remain within ownership boundaries.

## Phase 6: CI and release supply chain

- [ ] T27: Create verification CI for TS, Rust, GUI, bundle and security/license checks.
- [ ] T28: Generate reproducible payload evidence, SBOM, hashes, conditional signatures and attestation.
- [ ] T29: Implement immutable GitHub draft approval and npm OIDC publishing.
- [ ] T30: Synchronize user documentation and retire/deprecate legacy install entry points.

### Checkpoint G

- [ ] Clean-tag CI is the only producer of public assets.
- [ ] Every artifact maps to one version, commit, manifest, SHA-256 and attestation.
- [ ] Signed assets verify publisher/timestamp; unsigned releases contain required warnings.
- [ ] GitHub and npm use identical SemVer/commit; `next`/`latest` behavior is verified.

## Phase 7: RC hardening and stable promotion

- [ ] T31: Execute client matrices, publish RCs, freeze last RC and promote stable.

### Final checkpoint

- [ ] Windows 11 25H2 full lifecycle passes.
- [ ] Windows 11 24H2 compatibility, 26H1 manual smoke and Windows 10 22H2 legacy matrix pass.
- [ ] P0/P1 are zero; release-blocking P2 are zero.
- [ ] Stable differs from the last passing RC only by allowlisted version metadata/release notes.
- [ ] `0.2.0` immutable Release and npm `latest` are public with complete evidence bundle.

## Parallelization opportunities

- After T03/T05 contracts stabilize, T08 Windows adapter work can run alongside T06 migration/T07 journal, with contract ownership coordinated through T03/T05.
- After T12, T14 history and T15 detection can run in parallel; T13 owns CLI surfaces, T16 owns security middleware.
- After T19/T20 interfaces stabilize, T21 diagnostics and T22 helper can run in parallel.
- T27 CI scaffolding can begin after Checkpoint C while installer work continues, but release jobs remain disabled until T26/T28.
- Documentation T30 can begin incrementally after each interface checkpoint, then receive a final consistency pass.

Shared schema, application-service and installer-state contracts must be merged before dependent parallel work starts. No two tasks should independently edit the same schema or invent alternate status semantics.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Legacy backup lacks original values | High: irreversible false restore | Fail closed to recovery_required; preserve original file; never infer protected current values |
| Windows multi-store partial failure | High: configuration drift | Durable journal, authority readback, reverse compensation, convergent restore, exhaustive fault injection |
| Tauri/local service authentication bypass | High: local privilege misuse | Session token exchange, Host/Origin/CSRF checks, loopback bind, no remote navigation/capabilities |
| Helper expands privilege boundary | High | One request, allowlisted policy slots/types, transaction binding, ordinary-process verification |
| Installer removes recovery data | Critical | State preflight, default retention, restore-first uninstall, reparse/absolute-boundary tests |
| WebView2 offline/reboot variability | Medium | Bundle offline installer, re-probe, stable reboot result, never auto-reboot/start |
| Non-deterministic installer/signature | Medium | Compare extracted unsigned managed payload; document allowed timestamp differences |
| Windows client automation availability | High: release blocked | Prepare reusable VM snapshots early in T26; keep manual evidence template for 26H1 |
| Existing tests codify legacy bugs | High | Replace expectations only with ADR-linked target tests; maintain red→green evidence |
| Dependency/license vulnerability | High | Lock sources/hashes, SBOM, runtime-only scan, license gate and time-bounded medium waivers |
| VPN/DNS side effects during tests | Critical | Mock/isolated inspection only; before/after network snapshot invariant |

## Open questions

None at product level. Implementation discoveries that contradict ADR 0004–0010 stop the dependent task and require spec/ADR review before code continues.

