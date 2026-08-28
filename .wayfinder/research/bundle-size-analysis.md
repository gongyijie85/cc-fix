# Bundle Size & Dependency Contribution Analysis

**Ticket**: #66  
**Date**: 2026-01-15  
**Tool**: tsup v8.5.1, Node.js target: node24  
**Config**: `splitting: false`, `noExternal: [/.*/]` (all deps bundled)

---

## 1. Build Output (splitting: false — current config)

| File | Size (bytes) | Size (KB) |
|------|-------------|-----------|
| `dist/index.js` | 506,238 | 494.4 KB |
| `dist/gui/sidecar.js` | 257,006 | 251.0 KB |
| `dist/index.js.map` | 907,565 | 886.3 KB |
| `dist/gui/sidecar.js.map` | 547,245 | 534.4 KB |
| `dist/index.d.ts` | 13 | 0.01 KB |
| `dist/gui/sidecar.d.ts` | 13 | 0.01 KB |
| **Total JS** | **763,244** | **745.4 KB** |
| **Total dist/** | **2,218,080** | **2.12 MB** |

## 2. Assets Directory

| File | Size (bytes) | Size (KB) |
|------|-------------|-----------|
| `assets/fonts/cc-fix-noto-sans-sc.woff2` | 278,596 | 272.1 KB |
| `assets/gui/app.js` | 22,657 | 22.1 KB |
| `assets/gui/app.css` | 12,970 | 12.7 KB |
| `assets/gui/renderers.js` | 3,280 | 3.2 KB |
| `assets/fonts/OFL-1.1.txt` | 4,229 | 4.1 KB |
| `assets/gui/state.js` | 679 | 0.7 KB |
| `assets/fonts/NOTICE.txt` | 350 | 0.3 KB |
| `assets/icon.svg` | 502 | 0.5 KB |
| **Total assets/** | **323,263** | **315.7 KB** |

## 3. Splitting Comparison (splitting: true vs false)

### With `splitting: true`

| File | Size (bytes) | Size (KB) |
|------|-------------|-----------|
| `dist/index.js` | 225,263 | 220.0 KB |
| `dist/chunk-QQL5ODBO.js` | 166,760 | 162.9 KB |
| `dist/chunk-D3OLEB5R.js` | 50,055 | 48.9 KB |
| `dist/chunk-NASLCHJF.js` | 42,433 | 41.4 KB |
| `dist/chunk-ZDIEGRZC.js` | 1,912 | 1.9 KB |
| `dist/injector-NYBHE2R5.js` | 1,596 | 1.6 KB |
| `dist/gui/sidecar.js` | 1,084 | 1.1 KB |
| `dist/preflight-WBDU2OYI.js` | 532 | 0.5 KB |
| `dist/runtime-DXU6TUIH.js` | 519 | 0.5 KB |
| `dist/server-T5AUJG7H.js` | 352 | 0.3 KB |
| **Total JS** | **490,506** | **479.0 KB** |

### Comparison

| Metric | splitting: false | splitting: true | Delta |
|--------|-----------------|-----------------|-------|
| Total JS size | 745.4 KB | 479.0 KB | **-266.4 KB (-35.7%)** |
| Number of JS files | 2 | 10 | +8 files |
| index.js size | 494.4 KB | 220.0 KB | -274.4 KB |
| sidecar.js size | 251.0 KB | 1.1 KB | -249.9 KB |

**Key finding**: Enabling `splitting: true` reduces total JS by **35.7%** (266 KB) because shared dependencies (chalk, commander, cli-table3) between index.js and sidecar.js are extracted into common chunks instead of being duplicated.

## 4. Dependency Contribution (index.js — splitting: false)

| Dependency | Size | % of index.js | Notes |
|-----------|------|---------------|-------|
| **cli-table3** (+ @colors/colors) | 267.8 KB | **54.3%** | Table rendering; pulls in @colors/colors (19.8 KB) |
| **commander** | 166.1 KB | **33.7%** | CLI framework |
| **chalk** (+ ansi-styles) | 43.4 KB | **8.8%** | Terminal coloring |
| **emoji-regex** | 10.2 KB | **2.1%** | Transitive dep of string-width |
| **string-width** (+ helpers) | 3.9 KB | **0.8%** | Width calculation (ansi-regex, strip-ansi, is-fullwidth-code-point) |
| **App source code** | ~2.0 KB | **0.4%** | CLI entry point, command definitions |

### sidecar.js (splitting: false)

- **251.0 KB** — 100% application code (GUI server, HTML template, session management)
- **0 external dependencies** bundled (uses only Node.js built-ins: http, crypto, fs, url)

## 5. Source Code vs Bundle

| Metric | Size |
|--------|------|
| Source `.ts` files | 790.9 KB (149 files) |
| Bundled JS (total) | 745.4 KB |
| Dependency overhead | ~743.4 KB (99.7% of index.js) |

## 6. Key Findings

1. **cli-table3 is the largest dependency** at 267.8 KB (54.3% of index.js). It pulls in `@colors/colors` (19.8 KB) as a transitive dependency. This is the single biggest optimization target.

2. **commander is the second largest** at 166.1 KB (33.7%). For a CLI with ~8 commands, this is substantial overhead. Consider lighter alternatives like `citty` or `meow`.

3. **chalk contributes 43.4 KB** (8.8%). chalk v5 is ESM-only and tree-shakeable, but with `noExternal: [/.*/]` everything is bundled.

4. **The app's own code in index.js is only ~2 KB** — the CLI entry point is extremely lean. All the bulk comes from dependencies.

5. **sidecar.js has zero dependency overhead** — it's pure application code using only Node.js built-ins.

6. **splitting: true saves 35.7%** (266 KB) by deduplicating shared dependencies between the two entry points. However, it produces 10 files instead of 2, which may complicate distribution.

7. **The `noExternal: [/.*/]` config** bundles ALL dependencies (including transitive ones like `@colors/colors`, `emoji-regex`). This is intentional for a self-contained CLI binary but inflates size.

8. **Total npm package payload** (dist/ + assets/ + scripts/) is approximately **1.06 MB** of JS + assets (excluding source maps and .d.ts files).

## 7. Optimization Opportunities

| Opportunity | Potential Savings | Effort |
|-------------|------------------|--------|
| Replace cli-table3 with lighter alternative (e.g., `table` or custom) | ~250 KB | Medium |
| Replace commander with citty/meow | ~140 KB | Medium |
| Enable splitting: true | ~266 KB (dedup) | Low (config change) |
| Lazy-load chalk (dynamic import) | ~43 KB off initial load | Low |
| Replace chalk with `picocolors` | ~40 KB | Low |
