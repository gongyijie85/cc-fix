# Tauri Desktop Shell — Startup Chain Timing Analysis

Ticket #83 · CC-Fix · `D:\cc-fix`
Date: 2026-08-28 · Host: Windows (Win32), headless/CI-capable agent

## Goal

Measure the `src-tauri/` desktop shell startup chain. The shell spawns a private Node
sidecar (`core/sidecar.js` via `runtime/node.exe`) with `CC_FIX_GUI_TOKEN` /
`CC_FIX_GUI_SESSION_ID` / `CC_FIX_DESKTOP`, waits ≤20s for one `{type:"ready",sessionId,url}`
line on stdout, then opens a WebView2 at that `http://127.0.0.1:` URL.

## What `main.rs` spawns (src-tauri/src/main.rs::spawn_sidecar, lines 111-164)

- Node: `CC_FIX_NODE_EXE` env else `<exe_dir>/runtime/node.exe`
- Script: `CC_FIX_GUI_SIDECAR` env else `<exe_dir>/core/sidecar.js` (single arg to node)
- `bootstrap = uuid.simple()+uuid.simple()` (`CC_FIX_GUI_TOKEN`)
- `session_id = uuid.simple()+uuid.simple()` (`CC_FIX_GUI_SESSION_ID`)
- Env `CC_FIX_DESKTOP=1`; `stdin=null`, `stdout=piped`, `stderr=null`
- `creation_flags = 0x0800_0000` (CREATE_NO_WINDOW)
- Reader thread reads **1 line** of stdout; `recv_timeout(20s)`
- Validates: `type=="ready"`, `sessionId==session_id`, `url` starts `http://127.0.0.1:`, `url.contains(bootstrap)`

## Reproduction (sidecar only, no Tauri)

Ran the real payload files with the exact env/args above; validated the JSON is non-trivially
accepted by every check `main.rs` performs. 3x runs, median.

| Config | node runtime | median cold-start→ready |
|---|---|---|
| `dist/gui/sidecar.js` (fresh `pnpm build`) | system node **v25.9.0** | **114.8 ms** |
| `release/payload/core/sidecar.js` (installed layout) | bundled node **v24.18.1** | **110.5 ms** |

Ready line observed and matched: `{"type":"ready","sessionId":<session>,"url":"http://127.0.0.1:<ephemeralPort>/?token=<bootstrap>"}` — passes all `main.rs` checks.

### Stage breakdown (release payload = what the shell launches)

| # | Stage | Time | Source |
|---|---|---|---|
| 0 | Node binary boot (V8/loader init) | ~68 ms | **measured** (`node -e process.exit(0)`, bundled node 24.18.1, median 67.9–68.2 ms) |
| 1 | ESM module load (full 257 KB bundle: detection/persist/fonts/server + inlined HTML) | ~0–12 ms | **measured** (sidecar total ≈ bare-node+http-bind; bundle adds nothing measurable) |
| 2 | `GuiSession` construction (field assign + length check) | <1 ms | estimated (synchronous) |
| 3 | HTTP server `createServer` + `listen(0, 127.0.0.1)` bind → `'listening'` | ~42 ms net (110 ms incl. boot) | **measured** (node boot + http import + bind + close = 110.4 ms med) |
| 4 | `bootstrapUrl()` + `JSON.stringify` + `stdout.write` | <1 ms | estimated |
| 5 | **Sidecar ready total** | **~110.5 ms** | **measured** |

Derived delta (estimates, not independently measured): module import + session + listen + write ≈ 110.5 − 68 ≈ **42 ms**, dominated by the HTTP listen bind.

### Observed sequencing facts (task item 2)
- No fixed sleeps, no retry/poll loop. The sidecar `listen(0)` binds **once** on an ephemeral port and resolves a `'listening'` callback; ready is written immediately after. **No port probe/tuning loop** inside the sidecar.
- The 20 s `recv_timeout` is a safety margin, not a latency contributor (measured readiness is ~110 ms → ~180x headroom).
- `main.rs` is strictly sequential inside `setup()`: spawn sidecar → wait ready → assign kill-job → build WebView window → run event loop. The sidecar-ready wait is fully serial (blocking) before any window work.

## What CANNOT be measured here (real WebView2 desktop session required)

WebView2 Runtime **is** installed (151.0.4129.107), so a full desktop run is *possible* on this
machine, but not from this sidecar-only harness. These stages need an interactive desktop/GPU
session and were **not measured** (estimates only):

- Rust/Tauri binary launch, `tauri_plugin_single_instance` named IPC check (serial/input, <50 ms est.)
- `DiagnosticLog` init + `%APPDATA%\cc-fix\logs` creation (sub-ms est.)
- `WebviewWindowBuilder` → WebView2 environment/browser-process creation (100–1000 ms est.)
- WebView navigation to `http://127.0.0.1:<port>/?token=...`
- Page load: HTML+CSS render, `app.js`/`renderers.js`/`state.js`, woff2 font fetch
- Hydration / first render; initial `GET /api/status` (persist runtime migration) + SSE `/api/events` connect
- **First paint / user-visible ready** (dominant, unmeasured here)

## Top-2 bottlenecks

1. **Node runtime boot** (~68 ms) — fixed cost of spawning the bundled `node.exe`; the largest single measured chunk.
2. **HTTP server `listen()` bind on 127.0.0.1** (~42 ms net, ~110 ms with boot) — the sidecar's own "ready" path is dominated by the bare loopback bind, not by the heavy detection/persist modules (bundle import is essentially free here).

Implication: the ~110 ms sidecar cold start is almost entirely Node boot + one loopback bind; the CLI
logic/module graph is not the bottleneck. Any further optimization must target the runtime, not the bundle.

## Reproducer scripts (left in repo temp)
- `.wayfinder/temp/measure-sidecar.mjs` — spawns sidecar w/ exact env/args, times to ready line, validates JSON.
- `.wayfinder/temp/measure-baseline.mjs` — `node -e process.exit(0)` boot baseline.
- `.wayfinder/temp/measure-httpbind.mjs` — node boot + http import + `listen(0)` bind cost.
