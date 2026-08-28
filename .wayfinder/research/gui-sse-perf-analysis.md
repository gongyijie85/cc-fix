# GUI / SSE Performance (CC-Fix #82)

**Date**: 2026-08-28 · **Build**: `pnpm build` (`splitting:true`, node20). Probes in `.wayfinder/temp/gui-perf/` re-run against current `dist/gui/sidecar.js`; each run spawns a fresh isolated sidecar (fresh `APPDATA`, random port/token, cold browser context). 3 runs, median.

## Measurements

### First load (cold cache)

| Metric | Runs (ms) | Median |
|---|---|---|
| DOMContentLoaded | 21 / 15 / 16 | **16** |
| load event | 23 / 18 / 19 | **19** |
| First Contentful Paint | 836 / 28 / 40 | **40** |

Assets ≈ 318 KB; the 272 KB font (`cc-fix-noto-sans-sc.woff2`, 278,596 B) is **87.5%** of it but is served locally in ~4 ms, `immutable`-cached, fetched **once**. Shell paints 28–40 ms; **app-readiness** is gated by the first `GET /api/status` = **~223 ms** (runs 223/213/224 ms) — the status bar stays "检测中…" until it resolves.

### SSE push latency (runtime warmed)

`POST /api/check/start` → **202 in ~1 ms**; 11 `detect-ok` signals per run.

| Event (ms after POST) | Runs | Median |
|---|---|---|
| `phase` / `detect-start` | 619 / 342 / 344 | **344** |
| `detect-done` | 669 / 394 / 395 | **395** |

## Rendering path

- `detect-ok` → **PATCH** (`renderers.js:showDetectSignal`): updates one row by ID (`textContent`/`innerHTML`). Cheap.
- `detect-start` → **full sub-render** (`showDetectStart`): rebuilds `#detectList` (13 rows).
- `detect-done` → **global full re-render** (`app.js:render`): `$("#content").innerHTML = html` rebuilds the whole card (score + inline-SVG IP grid + signals table + selects + 4 buttons + recommendations), re-attaches listeners, refetches `/api/regions`+`/api/status`+`/api/history` (`verify-render.mjs`: `/api/status`×2, `/api/history`×2, font=1).

## Top-3 bottlenecks

1. **SSE first-event stall — `fetchIpIntelligence()`** (~344 ms median; up to 620 ms). `handleCheckStart` (`server.ts:255-267`) returns 202, then awaits `status()` → `getTargetRegion()` → `await fetchIpIntelligence()` **before** `runDetection` broadcasts anything, so the UI sits idle ~344 ms until the IP-intel lookup resolves.
2. **First-load status-init** (~223 ms). First `/api/status` lazily initialises the persist-runtime singleton (`server.ts:74-80`); later calls are ~4 ms. Sits on every fresh-launch readiness path.
3. **Per-event full `#content` re-render on `detect-done`** + redundant refetches. `render()` rebuilds the whole content tree and re-fetches `/api/regions`+`/api/status`+`/api/history` each completion, resetting the user's `#regionSelect`. Only the terminal event re-renders globally.

Non-bottleneck: 272 KB font is `immutable`-cached and loads in ~4 ms locally.

## Directions (not implemented)

- SSE: emit an immediate "受理" frame; run `fetchIpIntelligence()` parallel to `status()`.
- First-load: pre-warm `getRuntime()` during sidecar boot.
- Rendering: drop the unconditional `loadRegions().then(loadStatus)` refetch; reuse the patch mechanism for `detect-done`.
