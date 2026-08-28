# npm Publish Tarball Size & Content Analysis (post-#77)

**Ticket**: #81
**Scenario**: `pnpm build` → `npm pack` of the post-#77 bundle (tsup `splitting:true`, `noExternal:[/.*/]`, `sourcemap:true`, `dts:true`, `target:node20`).
**Tooling**: tsup v8.5.1, npm 11 (pack), Node v25 (build host). Tarball measured from `npm pack --pack-destination` artifact + `tar -tvf`.

---

## 1. Totals

| Metric | Bytes | KiB |
|--------|-------|-----|
| **Packed tarball** (`cc-fix-0.2.0-rc.1.tgz`) | **594,525** | **580.6** |
| **Unpacked size** (all 34 entries) | **1,579,595** | **1,542.6** |
| Tarball entries | 34 | — |
| `node_modules` in tarball | **none** | — |
| Bundled/runtime deps (`bundled:[]`) | **none** | — |

---

## 2. File-by-file byte list (unpacked)

**dist/ — JS (10 files, 427,818 B)**
| File | Bytes |
|------|-------|
| dist/index.js | 160,104 |
| dist/chunk-S75K6GOB.js | 167,666 |
| dist/chunk-C3H5J3NS.js | 49,761 |
| dist/chunk-YDVEI6KC.js | 44,276 |
| dist/chunk-ZDIEGRZC.js | 1,912 |
| dist/injector-AITALCI3.js | 1,612 |
| dist/gui/sidecar.js | 1,084 |
| dist/preflight-WBDU2OYI.js | 532 |
| dist/runtime-E3NVW6UW.js | 519 |
| dist/server-RN2LPSBL.js | 352 |

**dist/ — sourcemaps (10 files, 815,991 B)**
| File | Bytes |
|------|-------|
| dist/chunk-S75K6GOB.js.map | 365,785 |
| dist/index.js.map | 257,296 |
| dist/chunk-YDVEI6KC.js.map | 97,479 |
| dist/chunk-C3H5J3NS.js.map | 89,427 |
| dist/injector-AITALCI3.js.map | 3,415 |
| dist/gui/sidecar.js.map | 1,684 |
| dist/preflight-WBDU2OYI.js.map | 692 |
| dist/chunk-ZDIEGRZC.js.map | 71 |
| dist/runtime-E3NVW6UW.js.map | 71 |
| dist/server-RN2LPSBL.js.map | 71 |

**dist/ — types (2 files, 26 B)**: `index.d.ts` 13, `gui/sidecar.d.ts` 13.

**assets/gui (4 files, 39,586 B)**: `app.css` 12,970 · `app.js` 22,657 · `renderers.js` 3,280 · `state.js` 679.

**assets/fonts (3 files, 283,175 B)**: `cc-fix-noto-sans-sc.woff2` 278,596 · `OFL-1.1.txt` 4,229 · `NOTICE.txt` 350.

**assets/icon.svg** 502.

**scripts/prepare-hooks.mjs** 703.

**Auto-included metadata (not from `files`)**: `package.json` 3,014 · `README.md` 7,683 · `LICENSE` 1,097. *(npm always ships these; `files` cannot drop them.)*

---

## 3. Category breakdown

| Category | Unpacked bytes | % of unpacked | Verdict |
|----------|---------------|---------------|---------|
| dist sourcemaps (`*.map`) | **815,991** | **51.7%** | **Remove** |
| dist JS (`*.js`) | 427,818 | 27.1% | Keep (runtime) |
| assets/fonts (incl. woff2) | 283,175 | 17.9% | Keep (GUI runtime) |
| assets/gui | 39,586 | 2.5% | Keep (GUI runtime) |
| package.json + README + LICENSE | 11,794 | 0.7% | Keep (required) |
| scripts/prepare-hooks.mjs | 703 | 0.04% | Keep (git-install) |
| assets/icon.svg | 502 | 0.03% | Keep |
| dist `.d.ts` | 26 | <0.01% | Keep (typings) |
| **Total** | **1,579,595** | 100% | |

---

## 4. Necessity verdicts

**(a) Sourcemaps — NOT needed by consumers.** Sourcemaps are only consumed by a source/stack-trace mapping tool (devtools, `--enable-source-maps`). A published CLI's end users never load `*.map` at runtime; Node does not auto-read them. They serve only the maintainers' own post-build debugging. **Safe to exclude.** `files` is top-level-only and does **not** support negation (`"!dist/**/*.map"` is invalid), so exclusion must happen at build time (`sourcemap:false`) or via a **postbuild prune** in the publish pipeline. Recommended: postbuild prune (e.g. delete `dist/**/*.map` after tsup in the npm-publish step only) so local/dev sourcemaps survive. **Caveat:** `scripts/build-windows-payload.ps1` packages the same `dist/`; a publish-only prune keeps desktop payloads untouched.

**(b) woff2 font — NEEDED.** `src/gui/server.ts:299-308` (`readBundledAsset`) resolves `../assets/fonts/…` / `../../assets/fonts/…` relative to `import.meta.url` of the bundled entry. In an installed package (`node_modules/cc-fix/dist/index.js`), this lands on `node_modules/cc-fix/assets/fonts/cc-fix-noto-sans-sc.woff2` — which exists because `files` ships `assets`. `src/index.ts:373` dynamically imports `startGuiServer` in the npm CLI, and the server serves `GET /assets/fonts/…` (`server.ts:419`). So the font and GUI assets **are** served from the installed package on the npm channel; they cannot be dropped without breaking the GUI's Chinese text rendering.

**(c) scripts/prepare-hooks.mjs (703 B) — keep (trivial).** Only `git config core.hooksPath` runs when a consumer installs **from git** (`prepare`). For registry consumers it exits 0 immediately. 703 B is negligible; no reason to special-case it.

**(4) Tree-shaking / no runtime deps — CONFIRMED.** tsup/esbuild bundles all deps (`noExternal:[/.*/]`) into the dist chunks at build time; `package.json` has **no `dependencies`** (only devDependencies). The tarball contains **zero `node_modules`** (`bundled:[]`, and `tar -tvf` shows none). No runtime install is required.

---

## 5. Recommended reductions (packed-byte savings)

| Change | Mechanism | Packed saved | New packed |
|--------|-----------|--------------|------------|
| **Exclude sourcemaps** | Postbuild prune (or `sourcemap:false`) in publish path | **196,049 B (191.5 KiB, −33%)** | **398,476 B (389.1 KiB)** |
| Keep GUI/fonts | `files` already correct — no savings here | 0 | — |
| Swap heavy deps (cli-table3/commander) | Out of scope for #81; tracked in `bundle-size-analysis.md` | — | — |

**Bottom line**: the single highest-value reduction is dropping sourcemaps — **−196 KiB (33%) of the published tarball**, bringing it from **594.5 kB → 398.5 kB**. The woff2 font (278.6 kB unpacked) and GUI assets are required for the npm GUI channel and must stay; the font is already woff2 (max compression). Everything else in the tarball is either runtime code or mandatory npm metadata.
