# CLI Startup & Detection Pipeline Profiling Analysis

**Ticket**: #67  
**Date**: 2026-01-15  
**Environment**: Windows (win32), Node.js, PowerShell  

---

## 1. End-to-End Timing (Median of 3 Runs)

| Run | Time (ms) |
|-----|-----------|
| 1   | 1074.88   |
| 2   | 1124.84   |
| 3   | 1013.69   |
| **Median** | **1074.88** |

Command: `node dist/index.js check --region us`

The `check` command executes:
1. CLI argument parsing (commander)
2. IP intelligence fetch (`fetchIpIntelligence`) — 2 parallel HTTP requests
3. Detection pipeline (`runDetection`) — 11 plugins via `Promise.all`
4. History recording (`recordCheck`) — JSONL file append

---

## 2. Plugin I/O Inventory

### Plugins That Perform I/O

| Plugin | I/O Type | Sync/Async | Description |
|--------|----------|------------|-------------|
| **timezone** | Child process spawn | **Async** (`execFileAsync`) | Spawns `node -e` subprocess to read ICU timezone without TZ env contamination |
| **language** | Registry query | **Async** (`execFileAsync` via `readUserEnvVar`) | Reads `HKCU\Environment\LANG` via `reg query` |
| **locale** | Registry query | **Async** (`execFileAsync` via `readUserLocale`) | Reads `HKCU\Control Panel\International\LocaleName` via `reg query` |
| **consistency** | Child process + Registry | **Async** | Calls `systemState()` (subprocess) + `readUserLocale()` (registry) |
| **fonts** | **Filesystem readdirSync** | **SYNC** (`readdirSync`) | Reads `C:\Windows\Fonts` directory synchronously |
| **dns** | DNS lookup + HTTP | **Async** | `dns.lookup` with 5s timeout + `fetch` to ip-api.com with 3s timeout |
| **base-url** | Env var read | **None** (in-memory) | Reads `process.env.ANTHROPIC_BASE_URL` |
| **proxy** | Env var read | **None** (in-memory) | Reads proxy env vars from `process.env` |
| **win-region** | **Registry query via execSync** | **SYNC** (`execSync`) | Runs `reg query` synchronously with 3s timeout |
| **utc-offset** | Child process spawn | **Async** (`execFileAsync` via `systemState()`) | Shares cached `systemState()` with timezone plugin |
| **browser-policy** | **Registry queries via execFile** | **Async** (`execFile` callback) | Reads 6 Chrome/Edge policy slots via `reg query` (up to 6 sequential spawns) |

### Non-Plugin I/O in the `check` Pipeline

| Component | I/O Type | Sync/Async | Description |
|-----------|----------|------------|-------------|
| **fetchIpIntelligence** | 2x HTTP requests | **Async** (parallel `fetch`) | ip-api.com (5s timeout) + ipinfo.io (5s timeout) |
| **recordCheck** | File append | **Async** | Appends JSONL to history file |

### Plugins With Zero I/O

| Plugin | Reason |
|--------|--------|
| **base-url** | Reads `process.env` only |
| **proxy** | Reads `process.env` only |
| **ip-intel** (derived) | Pure computation from pre-fetched `IpIntelligence` object |

---

## 3. Sync vs Async I/O Summary

| Plugin | Sync I/O? | Async I/O? |
|--------|-----------|------------|
| fonts | **YES** — `readdirSync` on `C:\Windows\Fonts` | No |
| win-region | **YES** — `execSync` for `reg query` | No |
| timezone | No | Yes — `execFileAsync` subprocess |
| language | No | Yes — `execFileAsync` registry |
| locale | No | Yes — `execFileAsync` registry |
| consistency | No | Yes — `execFileAsync` + registry |
| dns | No | Yes — `dns.lookup` + `fetch` |
| browser-policy | No | Yes — `execFile` callback (6 sequential) |
| utc-offset | No | Yes — shares `systemState()` cache |
| base-url | No | No (pure memory) |
| proxy | No | No (pure memory) |

---

## 4. Top 3 Likely Bottlenecks

### Bottleneck #1: IP Intelligence Fetch (~400-600ms estimated)

**Location**: `src/proxy/ip-intel.ts` → `fetchIpIntelligence()`  
**Impact**: **HIGH** — This runs *before* the detection pipeline and is on the critical path.

The function makes 2 parallel HTTP requests:
- `http://ip-api.com/json/?lang=zh-CN` (5s timeout)
- `https://ipinfo.io/json` (5s timeout)

Even though they run in parallel, network latency to these APIs dominates. From the test environment (Singapore datacenter IP), round-trip times to these services are the single largest contributor to total wall-clock time. The DNS plugin also makes a secondary HTTP call to `ip-api.com` for geo-lookup (3s timeout), adding another network hop.

**Evidence**: The `check` command output shows IP intelligence data (country, ASN, org, etc.) which confirms these requests complete. The ~1s total runtime is consistent with 1-2 network round trips at typical latency.

### Bottleneck #2: systemState() Subprocess Spawn (~100-200ms estimated)

**Location**: `src/platform/system-state.ts` → `computeSystemState()`  
**Impact**: **MEDIUM** — Spawns a full Node.js subprocess.

On Windows, `systemState()` spawns `node --input-type=module -e "console.log(...)"` with a cleaned environment (no TZ) to get the real system timezone. This subprocess:
1. Forks a new Node.js process
2. Initializes the V8 runtime
3. Runs ICU timezone resolution
4. Serializes output as JSON

This is called by **3 plugins** (timezone, consistency, utc-offset) but is cached within a single detection run via `systemStatePromise`. However, the first call still pays the full subprocess cost. On Windows, process creation overhead is typically 50-150ms.

### Bottleneck #3: Browser Policy Plugin — 6 Sequential Registry Reads (~100-300ms estimated)

**Location**: `src/detection/plugins/browser-policy.ts` + `src/platform/browser.ts`  
**Impact**: **MEDIUM** — 6 sequential `execFile` calls to `reg query`.

The browser policy plugin iterates over `BROWSER_POLICY_SLOTS` (6 slots for Chrome/Edge) and calls `getPolicy()` for each one sequentially. Each `getPolicy()` call spawns a `reg query` subprocess. On Windows, each `reg` spawn costs ~15-50ms, totaling ~90-300ms for 6 sequential calls.

Additionally, `detectRunningBrowsers()` spawns `tasklist /NH` (another subprocess), though this may be called elsewhere or cached.

### Honorable Mention: fonts Plugin (Sync readdirSync)

**Location**: `src/detection/plugins/fonts.ts` → `detectChineseFonts()`  
**Impact**: **LOW-MEDIUM** — Synchronous filesystem read blocks the event loop.

Uses `readdirSync` on `C:\Windows\Fonts` which typically contains 100-400 files. While the I/O itself is fast (directory metadata is usually cached by the OS), the synchronous call blocks the Node.js event loop. Since all plugins run via `Promise.all`, this sync call prevents other async callbacks from being processed during its execution. On a cold filesystem cache or slow disk, this could stall for 10-50ms.

---

## 5. Impact Assessment: Converting Sync I/O to Async

### fonts Plugin: `readdirSync` → `readdir` (async)

**Current**: `readdirSync(getFontsDir())` — blocks event loop  
**Proposed**: `await readdir(getFontsDir())` (from `node:fs/promises`)  
**Estimated Impact**: **Low (5-20ms improvement)**

- The OS typically caches the Fonts directory metadata, so actual I/O latency is minimal
- The real benefit is unblocking the event loop during the read, allowing other `Promise.all` siblings to process their callbacks
- On cold cache or slow disk, improvement could be more significant
- **Risk**: Very low — straightforward API swap, same semantics

### win-region Plugin: `execSync` → `execFile` (async)

**Current**: `execSync('reg query ...')` with 3s timeout — blocks event loop  
**Proposed**: `await execFileAsync('reg', ['query', ...])` with timeout  
**Estimated Impact**: **Medium (15-50ms improvement)**

- `reg query` on Windows typically completes in 15-50ms
- The sync call blocks the entire event loop during this time
- Since `Promise.all` runs all plugins concurrently, unblocking allows the DNS lookup, IP fetch callbacks, and other async work to proceed in parallel
- **Risk**: Low — the `system-state.ts` module already demonstrates the async pattern for registry reads

### browser-policy Plugin: Sequential → Parallel Registry Reads

**Current**: 6 sequential `execFile` calls in a `for` loop  
**Proposed**: `Promise.all(BROWSER_POLICY_SLOTS.map(slot => getPolicy(slot.id)))`  
**Estimated Impact**: **High (60-250ms improvement)**

- Currently: 6 × ~30ms = ~180ms sequential
- Proposed: max(~30ms) = ~30ms parallel
- The registry reads are independent (different key paths for Chrome vs Edge)
- **Risk**: Low — `getPolicy()` is already async, just called sequentially

### Combined Estimated Impact

| Change | Current Cost | After Change | Savings |
|--------|-------------|--------------|---------|
| fonts: readdirSync → readdir | 5-20ms (blocked) | 5-20ms (non-blocking) | Event loop unblocked |
| win-region: execSync → execFile | 15-50ms (blocked) | 15-50ms (non-blocking) | Event loop unblocked |
| browser-policy: sequential → parallel | 90-300ms | 15-50ms | **60-250ms** |
| **Total estimated savings** | | | **~80-300ms** |

Given the median runtime of ~1075ms, these changes could reduce it to **~800-1000ms** (10-25% improvement).

### Additional Optimization Opportunities (Not Sync→Async)

1. **IP Intelligence Caching**: Cache `fetchIpIntelligence()` results for a short TTL (e.g., 60s) to avoid redundant network calls when running `check` multiple times
2. **systemState() Subprocess → Native Binding**: Replace the Node.js subprocess spawn with a native addon or direct Windows API call (e.g., `GetTimeZoneInformation`) to avoid V8 cold-start overhead
3. **DNS Plugin**: The secondary `fetch` to `ip-api.com` for geo-lookup could be eliminated if IP intelligence already provides geo data (it does — `fetchIpIntelligence` already queries ip-api.com)

---

## 6. Architecture Notes

- All plugins run via `Promise.all` (true concurrency) — good design
- `systemState()` uses a single-flight cache (`systemStatePromise`) — prevents duplicate subprocess spawns within one detection run
- `resetSystemState()` is called at the start of each `runDetection()` — ensures fresh reads across runs
- The `ip-intel` derived plugins are pure computation (no I/O) — zero overhead
- `base-url` and `proxy` plugins read `process.env` only — zero I/O cost
- The `recordCheck` JSONL append is fire-and-forget (`await` but non-critical path)

---

## 7. Summary

The ~1075ms median runtime is dominated by:
1. **Network I/O** (~400-600ms): IP intelligence fetch (2 parallel HTTP requests)
2. **Process spawning** (~100-200ms): Node.js subprocess for timezone detection
3. **Sequential registry reads** (~100-300ms): 6 browser policy slots queried one-by-one

The two sync I/O calls (`readdirSync` in fonts, `execSync` in win-region) are minor contributors but are architecturally undesirable because they block the event loop during `Promise.all` execution. Converting them to async is low-risk and improves overall pipeline parallelism.

The highest-ROI optimization is converting browser-policy's sequential registry reads to parallel, which could save 60-250ms. The next highest-ROI would be caching or eliminating redundant network calls in the IP intelligence + DNS geo-lookup path.
