# CC-Fix Windows 产品化 0.2 — Implementation Tasks

> Source of truth: [Windows 产品化 0.2 规格](../docs/spec/windows-productization-v0.2.md) and ADR 0004–0010. Tasks are dependency ordered. A task is not done until its verification evidence exists.

## T01: Establish contract and version single sources

**Description:** Adopt the approved local CONTEXT/ADR/spec baseline, make package version the only runtime version source, and pin release toolchain metadata without changing Windows settings behavior.

**Acceptance criteria:**
- [ ] `cc-fix --version`, package metadata and build metadata read one version source; planned first release is 0.2.0-rc.1.
- [ ] `toolchain.lock.json` records exact Node/Rust/Tauri/Inno/WebView2 sources and hashes or explicit unresolved bootstrap fields that fail release builds.
- [ ] ADR 0004–0010 and the new specification are tracked as authoritative contracts.

**Verification:**
- [ ] `pnpm typecheck`
- [ ] CLI version test asserts package/runtime equality.
- [ ] A consistency script fails when any declared version source differs.

**Dependencies:** None

**Files likely touched:** `package.json`, `src/version.ts`, `src/index.ts`, `src/version.test.ts`, `toolchain.lock.json`

**Estimated scope:** Medium

## T02: Add verification command scaffolding

**Description:** Add stable coverage, integration, GUI, core/desktop/installer and payload verification command names; early unavailable stages must fail with an explicit “not implemented” result rather than silently pass.

**Acceptance criteria:**
- [ ] Target commands from the spec exist in package scripts or documented wrappers.
- [ ] Coverage thresholds are configured: global 80/75 and critical module branch threshold 90 once those modules exist.
- [ ] Test outputs and artifacts use deterministic workspace-local directories ignored by Git；现有 `.wayfinder/temp`/worktrees 先分类和忽略，不删除用户证据。

**Verification:**
- [ ] `pnpm test`
- [ ] `pnpm test:coverage`
- [ ] Script contract tests distinguish implemented, skipped-by-policy and missing stages.

**Dependencies:** T01

**Files likely touched:** `package.json`, `vitest.config.ts`, `vitest.integration.config.ts`, `playwright.config.ts`, `.gitignore`

**Estimated scope:** Medium

## T03: Implement pure protection and region domain contracts

**Description:** Introduce the discriminated unions, target resolution, transition request validation and no-silent-fallback rules used by all later modules.

**Acceptance criteria:**
- [ ] ProtectionMode/Health/Target and RegionCode/ResolvedRegion match the spec.
- [ ] Explicit/active/preferred/initial-default resolution priority is exhaustive and illegal values fail.
- [ ] `--deep`/level conflicts and protected-mode defaults are represented as pure validation results.

**Verification:**
- [ ] `pnpm test -- src/domain`
- [ ] Named matrix tests cover daily/standard/deep × us/eu/jp/sg and invalid values.
- [ ] Existing unknown→US expectation is replaced by explicit failure.

**Dependencies:** T01

**Files likely touched:** `src/domain/protection.ts`, `src/domain/region.ts`, `src/domain/protection.test.ts`, `src/domain/region.test.ts`, `src/detection/regions.ts`

**Estimated scope:** Medium

## T04: Implement durable checked-file primitives

**Description:** Build reusable same-directory temp write, flush, checksum, atomic replace and validated predecessor recovery without embedding protection semantics.

**Acceptance criteria:**
- [ ] Current and `.prev` files carry verifiable checksums and reject partial/corrupt content.
- [ ] Write failure never destroys the last valid generation; predecessor is used only after validation.
- [ ] All filesystem targets are literal, absolute and confined to the supplied state root.

**Verification:**
- [ ] `pnpm test -- src/state/durable-file.test.ts`
- [ ] Fault tests inject open/write/flush/replace failures and corrupted current/prev pairs.
- [ ] Windows path/reparse boundary tests pass in an isolated temp root.

**Dependencies:** T02

**Files likely touched:** `src/state/durable-file.ts`, `src/state/durable-file.test.ts`, `src/state/checksum.ts`, `src/state/checksum.test.ts`

**Estimated scope:** Medium

## T05: Implement state v1 and immutable backup v4 repositories

**Description:** Persist committed target, preferred region, health and immutable daily snapshot with exact StoredValue semantics.

**Acceptance criteria:**
- [ ] state v1 never infers mode from backup presence and uses revisioned atomic commits.
- [ ] backup v4 captures every potentially managed value once and refuses overwrite until verified complete restore.
- [ ] missing/null/empty string/empty list remain distinct across encode/decode/restore inputs.

**Verification:**
- [ ] `pnpm test -- src/state/schema.test.ts src/state/repository.test.ts`
- [ ] Property/table tests round-trip every StoredValue variant.
- [ ] Concurrent revision mismatch fails closed without changing committed state.

**Dependencies:** T03, T04

**Files likely touched:** `src/state/schema.ts`, `src/state/schema.test.ts`, `src/state/repository.ts`, `src/state/repository.test.ts`, `src/state/paths.ts`

**Estimated scope:** Medium

## T06: Implement safe legacy migration

**Description:** Migrate existing v3 backup/activeRegion states without overwriting original evidence or filling absent daily values from the current environment.

**Acceptance criteria:**
- [ ] Legal activeRegion and uniquely matching settings migrate to explicit state; ambiguous/illegal/missing daily facts enter recovery_required.
- [ ] Migration creates a read-only copy and commits new state only after all validation.
- [ ] No code path assumes US for damaged legacy data.

**Verification:**
- [ ] `pnpm test -- src/state/migration.test.ts`
- [ ] Fixtures cover valid v3, illegal region, missing fields, protected-current ambiguity and corrupt JSON.
- [ ] Fixture hashes prove original backup bytes are unchanged.

**Dependencies:** T05

**Files likely touched:** `src/state/migration.ts`, `src/state/migration.test.ts`, `src/state/fixtures/legacy-v3.ts`, `src/platform/windows.ts`

**Estimated scope:** Medium

## T07: Implement live-owner lock and transaction journal

**Description:** Add PID/start-time/heartbeat ownership, dead-owner takeover and durable ordered step progress.

**Acceptance criteria:**
- [ ] A live owner cannot be displaced by file age; dead takeover verifies PID plus process start time.
- [ ] Journal records plan before writes and each applying/verified/compensating transition durably.
- [ ] Takeover always exposes the prior transaction to recovery before accepting new mutations.

**Verification:**
- [ ] `pnpm test -- src/state/lock.test.ts src/state/journal.test.ts`
- [ ] Two-process integration proves mutual exclusion and safe dead-owner takeover.
- [ ] Crash fixtures at every journal boundary decode to one deterministic recovery action.

**Dependencies:** T04, T05

**Files likely touched:** `src/state/lock.ts`, `src/state/lock.test.ts`, `src/state/journal.ts`, `src/state/journal.test.ts`, `src/state/process-owner.ts`

**Estimated scope:** Medium

## T08: Define Windows authority adapters

**Description:** Split environment, timezone, browser policy and locale/language/Culture reads/writes behind typed adapter contracts with authority readback.

**Acceptance criteria:**
- [ ] Every managed setting implements read/write/equality/restore StoredValue without owning transaction order.
- [ ] Only managed/denied browser policy errors receive the degradable classification; all unknown errors remain fatal.
- [ ] No adapter or test writes VPN, routing, adapter, hosts, DoH or DNS configuration.

**Verification:**
- [ ] `pnpm test -- src/platform/windows`
- [ ] Isolated HKCU/user fixture tests verify Unicode, missing/null/empty and registry value types.
- [ ] PowerShell inputs are parameterized and reject invalid region/value data.

**Dependencies:** T03

**Files likely touched:** `src/platform/windows/authority.ts`, `src/platform/windows/environment.ts`, `src/platform/windows/locale.ts`, `src/platform/windows/browser-policy.ts`, `src/platform/windows/authority.test.ts`

**Estimated scope:** Medium

## T09: Implement differential transition planning

**Description:** Generate an ordered plan from committed target, requested target, daily snapshot and observed authorities without performing writes.

**Acceptance criteria:**
- [ ] Plans cover daily→standard/deep, repeat align, region switch, standard↔deep and off.
- [ ] Standard excludes Locale/language/Culture writes; deep and deep→standard include exactly the required deltas.
- [ ] No-op, skipped and required/degradable steps are explicit and stable ordered.

**Verification:**
- [ ] `pnpm test -- src/persist/planner.test.ts`
- [ ] Snapshot matrix covers every mode×region transition and drift/no-drift case.
- [ ] A guard test fails if an external-network setting enters any plan.

**Dependencies:** T05, T08

**Files likely touched:** `src/persist/planner.ts`, `src/persist/planner.test.ts`, `src/persist/steps.ts`, `src/persist/steps.test.ts`

**Estimated scope:** Medium

## T10: Implement apply, verify, commit and full compensation

**Description:** Execute planned protection transitions with write-ahead journal, authority readback, atomic target commit and reverse compensation.

**Acceptance criteria:**
- [ ] New target is invisible until all required steps verify; policy-denied is the only degraded commit.
- [ ] Fatal failure compensates every modified step in reverse order and continues after compensation failures.
- [ ] Complete compensation preserves old target; incomplete compensation preserves old target plus recovery_required.

**Verification:**
- [ ] `pnpm test -- src/persist/executor.test.ts`
- [ ] Failure injection runs before/after every write/readback/journal/state commit boundary.
- [ ] Tests explicitly cover language-list and Culture compensation omitted by the legacy flow.

**Dependencies:** T07, T08, T09

**Files likely touched:** `src/persist/executor.ts`, `src/persist/executor.test.ts`, `src/persist/compensation.ts`, `src/persist/compensation.test.ts`, `src/persist/errors.ts`

**Estimated scope:** Medium

## T11: Implement convergent restore and crash recovery

**Description:** Restore all daily values without stopping at the first failure and resume unfinished protect/restore journals after process death.

**Acceptance criteria:**
- [ ] off attempts all fields, retains verified progress and is idempotent across retries.
- [ ] daily is committed and backup removed only after every StoredValue verifies.
- [ ] recover chooses reverse compensation for protect journals and forward convergence for restore journals.

**Verification:**
- [ ] `pnpm test -- src/persist/restore.test.ts src/persist/recovery.test.ts`
- [ ] Tests cover missing/null/empty, multiple simultaneous failures and crash at every step.
- [ ] Repeated daily off is a zero-code no-op without creating backup/journal.

**Dependencies:** T10

**Files likely touched:** `src/persist/restore.ts`, `src/persist/restore.test.ts`, `src/persist/recovery.ts`, `src/persist/recovery.test.ts`

**Estimated scope:** Medium

## T12: Cut over to one persist application service

**Description:** Provide status/on/off/recover APIs over the new repositories and engine, then remove legacy flow ownership of system writes.

**Acceptance criteria:**
- [ ] One application service is the only mutation entry and reports committed target, health and active transaction independently.
- [ ] Legacy v3 is read only through migration; no code path patches activeRegion into backup.
- [ ] Existing callers can be migrated without dual-writing system settings.

**Verification:**
- [ ] `pnpm test -- src/persist/service.test.ts`
- [ ] `rg` confirms production callers no longer invoke legacy write functions.
- [ ] Full typecheck/unit suite passes at Checkpoint C.

**Dependencies:** T06, T10, T11

**Files likely touched:** `src/persist/service.ts`, `src/persist/service.test.ts`, `src/fix/flow.ts`, `src/fix/flow.test.ts`, `src/platform/windows.ts`

**Estimated scope:** Medium

## T13: Implement CLI contract and stable exits

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

**Description:** Pass one ResolvedRegion through every plugin/result/history path and compare before/after only for the same target.

**Acceptance criteria:**
- [ ] CheckResponse reports actual code/source; `auto` is no longer a false target value.
- [ ] US/EU/JP/SG plugins consume the same catalog context; SG no longer self-reports unsafe `en-SG`.
- [ ] Different target or active transaction resets recheck baseline.

**Verification:**
- [ ] `pnpm test -- src/detection`
- [ ] New locale/consistency/win-region tests cover all four regions.
- [ ] check/run explicit override tests prove preferred/active state remains unchanged.

**Dependencies:** T03, T12, T14

**Files likely touched:** `src/detection/types.ts`, `src/detection/runner.ts`, `src/detection/scoring.ts`, `src/detection/plugins/consistency.ts`, `src/detection/runner.test.ts`

**Estimated scope:** Medium

## T16: Add authenticated localhost session middleware

**Description:** Implement token exchange, strict session cookie, Host/Origin/loopback/CSRF validation and authenticated SSE foundations independently of the page UX.

**Acceptance criteria:**
- [ ] Bootstrap token is single use, memory only and removed from visible URL after cookie exchange.
- [ ] API/SSE reject missing/wrong session, Host, Origin, CSRF and non-loopback requests.
- [ ] Session id participates in service-ready handshake and expires on desktop exit.

**Verification:**
- [ ] `pnpm test:integration -- --suite localhost-security`
- [ ] Negative matrix asserts 401/403 without side effects.
- [ ] Logs and errors never expose token/cookie values.

**Dependencies:** T12

**Files likely touched:** `src/gui/session.ts`, `src/gui/security.ts`, `src/gui/security.test.ts`, `src/gui/server.ts`, `src/gui/server.integration.test.ts`

**Estimated scope:** Medium

## T17: Move GUI API and SSE to v2 state

**Description:** Serve status, regions, check, target conversion, off and recover through the application service with one global mutation slot.

**Acceptance criteria:**
- [ ] Trigger endpoints return 202; global busy returns 409; read-only endpoints expose active transaction without committing it.
- [ ] Server validates region/level even for dropdown-originated requests.
- [ ] Recheck events include target and only compute delta for equal committed targets.

**Verification:**
- [ ] `pnpm test:integration -- --suite gui-api`
- [ ] Endpoint matrix covers all mode/health/region states and malformed requests.
- [ ] API cannot change preferred region while protected except through target conversion.

**Dependencies:** T15, T16

**Files likely touched:** `src/gui/server.ts`, `src/gui/routes.ts`, `src/gui/events.ts`, `src/gui/server.integration.test.ts`, `src/events/types.ts`

**Estimated scope:** Medium

## T18: Implement three-mode GUI and recovery UX

**Description:** Update the existing HTML GUI to display mode/health/regions, adjust atomic target, confirm deep impact and expose recovery/reminder-only states.

**Acceptance criteria:**
- [ ] Daily/standard/deep controls exactly match the approved action matrix and restore selected preferred/active region after re-render.
- [ ] Deep confirmation, target old→new impact, degraded slots and recovery-required actions are explicit.
- [ ] VPN/DNS/router findings show reminder-only text and no mutation button.

**Verification:**
- [ ] `pnpm test:gui`
- [ ] Playwright covers first load, refresh, all modes, non-US conversion, busy, degraded and recovery page.
- [ ] Accessibility smoke covers keyboard navigation, labels and status announcements.

**Dependencies:** T17

**Files likely touched:** `src/gui/index.html`, `tests/integration/gui.spec.ts`, `tests/integration/gui-fixtures.ts`, `playwright.config.ts`

**Estimated scope:** Medium

## T19: Build release core and private-runtime CLI launcher

**Description:** Produce a Node 24 ESM single-file noExternal core plus a relative launcher that never uses system Node or node_modules.

**Acceptance criteria:**
- [ ] Release bundle contains no third-party runtime imports or dynamic CommonJS require failure.
- [ ] Launcher resolves private node/core relative to install root from arbitrary working directories.
- [ ] check, status, run and GUI entries pass without system Node and without network.

**Verification:**
- [ ] `pnpm build:core`
- [ ] `pnpm verify:payload`
- [ ] A clean-path smoke hides system Node/node_modules and exercises all entries.

**Dependencies:** T13, T17

**Files likely touched:** `tsup.config.ts`, `src/run/injector.ts`, `scripts/build-core.mjs`, `launcher/cc-fix.cmd`, `tests/integration/bundle-smoke.test.ts`

**Estimated scope:** Medium

## T20: Implement production Tauri desktop lifecycle

**Description:** Port only the validated prototype shape into production: per-user single instance, random loopback service, authenticated readiness and deterministic child cleanup.

**Acceptance criteria:**
- [ ] Second launch focuses existing window; port conflict selects another port without weakening authentication.
- [ ] Window appears only after matching session-ready handshake; service/handshake failure displays native error state.
- [ ] Normal close gracefully stops and then bounds termination to the verified private child.

**Verification:**
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] `pnpm build:desktop`
- [ ] Windows integration covers second launch, collision, child crash and close cleanup.

**Dependencies:** T16, T19

**Files likely touched:** `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/src/session.rs`, `src-tauri/src/service.rs`

**Estimated scope:** Medium

## T21: Add desktop recovery, native errors and redacted diagnostics

**Description:** Handle incomplete journals, forced exit, runtime/WebView2/service failures and support diagnostics without exposing sensitive data.

**Acceptance criteria:**
- [ ] Active modification blocks first close; forced close is enabled only after journal durability confirmation.
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

**Description:** Add a one-request elevated helper for approved browser policy slots, bound to transaction/session and verified by the ordinary core.

**Acceptance criteria:**
- [ ] Helper accepts only fixed schema, allowed policy paths/values and a live transaction binding.
- [ ] Arbitrary command/script/path, replay and cross-session requests are rejected before elevation-side writes.
- [ ] UAC cancel maps to policy denied/degraded; unknown helper failures remain fatal.

**Verification:**
- [ ] Helper unit tests cover allowlist and malicious input corpus.
- [ ] Windows integration verifies UAC cancel, successful write/readback/restore and immediate helper exit.
- [ ] Main desktop/Node processes remain non-elevated.

**Dependencies:** T08, T10, T20

**Files likely touched:** `privileged-helper/Cargo.toml`, `privileged-helper/src/main.rs`, `privileged-helper/src/request.rs`, `src/platform/windows/browser-policy.ts`, `tests/windows/helper.ps1`

**Estimated scope:** Medium

## T23: Build per-user installer identity and payload

**Description:** Create stable-AppId Inno packaging for the desktop/core/runtime/helper, offline WebView2, shortcuts and exact current-user PATH segment.

**Acceptance criteria:**
- [ ] Installs to `%LOCALAPPDATA%\Programs\CC-Fix` without admin requirement and includes all offline payloads.
- [ ] Start Menu always exists; desktop/PATH defaults can be declined and are remembered; PATH is normalized/deduplicated.
- [ ] WebView2 missing path installs offline, re-probes and returns success/reboot/prerequisite results without auto-reboot.

**Verification:**
- [ ] `pnpm build:installer`
- [ ] Clean-user offline VM tests cover WebView2 present/absent and no system Node.
- [ ] Payload manifest matches installed managed files and contains no dev artifacts.

**Dependencies:** T19, T20, T22

**Files likely touched:** `installer/cc-fix.iss`, `installer/includes/payload.iss`, `installer/includes/path.iss`, `installer/includes/webview2.iss`, `scripts/build-installer.ps1`

**Estimated scope:** Medium

## T24: Implement state-aware upgrade and repair

**Description:** Add process/transaction preflight, higher-version replacement, same-version repair, downgrade refusal and complete file rollback.

**Acceptance criteria:**
- [ ] Only verified CC-Fix processes are gracefully closed; active/unfinished transaction blocks replacement.
- [ ] Upgrade retains old managed payload until new payload validates; failure restores a non-mixed launchable old version.
- [ ] Repair restores managed files/integration choices without changing state, backup, preferences or history; downgrade is refused.

**Verification:**
- [ ] VM tests cover idle process, active transaction, repair, upgrade success, injected copy failure and downgrade.
- [ ] Before/after hashes prove user state is unchanged.
- [ ] Rollback-failed case emits result 44 and prevents launch.

**Dependencies:** T12, T23

**Files likely touched:** `installer/includes/preflight.iss`, `installer/includes/upgrade.iss`, `installer/includes/repair.iss`, `scripts/windows/InstallerFixture.ps1`, `tests/windows/upgrade-cases.json`

**Estimated scope:** Medium

## T25: Implement restore-first uninstall and safe retention

**Description:** Make ordinary uninstall restore daily first, provide a clearly risky preserve-state escape, and constrain optional data deletion.

**Acceptance criteria:**
- [ ] Protected uninstall calls complete restore and proceeds only after verified daily; recovery_required blocks ordinary uninstall.
- [ ] Escape removes program but retains every recovery datum and prints reinstall instructions.
- [ ] Optional data deletion is daily/no-transaction only, allowlisted, absolute-root checked and reparse-point safe.

**Verification:**
- [ ] VM tests cover daily, standard, deep, recovery_required, restore failure, escape and remove-data cases.
- [ ] Reparse/junction and parent-boundary attacks return result 45 without deletion.
- [ ] PATH removal preserves all non-CC-Fix segments.

**Dependencies:** T11, T24

**Files likely touched:** `installer/includes/uninstall.iss`, `installer/includes/data-safety.iss`, `scripts/windows/Test-Uninstall.ps1`, `tests/windows/uninstall-cases.json`, `docs/uninstall.md`

**Estimated scope:** Medium

## T26: Build Windows client lifecycle harness

**Description:** Automate repeatable fresh/repair/upgrade/uninstall and protection scenarios with pre/post evidence and network no-change assertions.

**Acceptance criteria:**
- [ ] Harness resets/identifies client image, executes matrix cases and emits machine-readable result plus redacted logs.
- [ ] Captures managed settings/state/files/PATH/processes before/after and asserts exact restore/ownership.
- [ ] Captures VPN/route/adapter/DNS summary read-only and fails if any product lifecycle changes it.

**Verification:**
- [ ] `pnpm test:windows -- --matrix primary`
- [ ] Intentional product/network drift fixtures cause deterministic failures.
- [ ] Evidence package contains no seeded IP, token or environment secrets.

**Dependencies:** T23, T24, T25

**Files likely touched:** `scripts/windows/Test-InstallerLifecycle.ps1`, `scripts/windows/Capture-SystemState.ps1`, `scripts/windows/Compare-SystemState.ps1`, `tests/windows/matrix.json`, `tests/windows/README.md`

**Estimated scope:** Medium

## T27: Create continuous verification workflows

**Description:** Add clean checkout CI for TS/Rust/unit/integration/GUI/bundle plus secret, dependency and license gates; release jobs remain disabled until later tasks.

**Acceptance criteria:**
- [ ] Pull requests run deterministic install, typecheck, coverage, integration, GUI, Rust and bundle smoke.
- [ ] Critical/high runtime vulnerabilities, unknown licenses, secrets and flaky retry behavior block.
- [ ] Workflow permissions are least privilege; ordinary verification has no release credentials.

**Verification:**
- [ ] Workflow lint/syntax validation passes.
- [ ] Controlled failing branch proves each gate blocks.
- [ ] Artifacts include test reports and redacted logs with configured retention.

**Dependencies:** T02, T12, T18, T22

**Files likely touched:** `.github/workflows/verify.yml`, `scripts/ci/check-licenses.mjs`, `scripts/ci/check-runtime-vulns.mjs`, `scripts/ci/check-versions.mjs`, `package.json`

**Estimated scope:** Medium

## T28: Generate release evidence and conditional signatures

**Description:** Produce reproducible payload manifests, CycloneDX SBOM, third-party notices, build-info, signatures when configured, hashes and verified attestations.

**Acceptance criteria:**
- [ ] Two clean stable builds compare normalized unsigned payload/SBOM; managed-content differences block.
- [ ] Vendor Node/WebView2 hashes/signatures verify before packaging; owned PE signing occurs before public hashes.
- [ ] Unsigned builds are explicitly marked; signed builds verify SHA-256 RFC3161 timestamp/publisher; attestation is generated and verified.

**Verification:**
- [ ] `pnpm release:bundle -- --version 0.2.0-rc.1`
- [ ] `pnpm verify:payload`
- [ ] Tampered payload/SBOM/signature/attestation fixtures fail.

**Dependencies:** T23, T27

**Files likely touched:** `scripts/release/build-evidence.ps1`, `scripts/release/sign.ps1`, `scripts/release/verify-evidence.ps1`, `src/release/build-info.ts`, `toolchain.lock.json`

**Estimated scope:** Medium

## T29: Implement immutable GitHub and npm publishing

**Description:** Build draft→verify→approve→immutable GitHub Release and subsequent npm OIDC publishing with RC/stable dist-tags.

**Acceptance criteria:**
- [ ] Only clean version tags can create a draft containing the complete evidence bundle and Windows matrix links.
- [ ] Public release requires environment approval and asset verification; same-version replacement is impossible by policy.
- [ ] npm Trusted Publishing uses the same version/commit/tarball; RC uses next, stable uses latest.

**Verification:**
- [ ] Dry-run/test repository exercise validates workflow decisions without publishing production version.
- [ ] `gh attestation verify` and release asset verification run in workflow.
- [ ] npm pack/install smoke and provenance verification pass before publish step.

**Dependencies:** T26, T28

**Files likely touched:** `.github/workflows/release.yml`, `.github/workflows/promote.yml`, `scripts/release/prepare-release.mjs`, `scripts/release/verify-npm.mjs`, `package.json`

**Estimated scope:** Medium

## T30: Synchronize docs and retire legacy entry points

**Description:** Rewrite public behavior/install/upgrade/uninstall/security documentation and remove or turn old Node-global scripts into explicit compatibility notices.

**Acceptance criteria:**
- [ ] README/SPEC/CLI help disclose actual standard/deep/system changes, Windows support, installer flow and complete restore semantics.
- [ ] install.ps1/cc-fix.bat cannot misrepresent themselves as the Windows product installer; migration path is explicit.
- [ ] SmartScreen/signature/hash/attestation verification, manual upgrade and VPN/DNS reminder-only boundary are documented.

**Verification:**
- [ ] Documentation consistency script validates version, commands, modes, regions and support matrix.
- [ ] Every documented command is exercised in CLI help/smoke tests.
- [ ] Search finds no contradictory “native apps unaffected/no system changes” claims.

**Dependencies:** T18, T25, T29

**Files likely touched:** `README.md`, `SPEC.md`, `scripts/install.ps1`, `scripts/cc-fix.bat`, `docs/release-guide.md`

**Estimated scope:** Medium

## T31: Execute RC hardening and stable promotion

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
