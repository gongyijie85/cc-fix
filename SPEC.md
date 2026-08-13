# CC-Fix specification index

The original pre-productization CLI specification has been retired because it contradicted the implemented Windows behavior.

The authoritative product contract is [Windows productization v0.2](docs/spec/windows-productization-v0.2.md), together with ADR 0004–0010 under `docs/adr/`.

## Current invariants

- Protection has three modes: `daily`, `standard`, and `deep`; the default transition from daily is `standard`.
- `standard` manages user environment variables, Windows system timezone, and six Chrome/Edge policy slots.
- `deep` additionally manages LocaleName, the user language list, and user Culture.
- Mode, health, preferred region, committed target, and active transaction are separate persisted facts.
- `us`, `eu`, `jp`, and `sg` are the only legal region codes; an invalid explicit code fails and never falls back silently.
- All changes are journaled, read back, compensated on failure, and restored from an immutable daily snapshot.
- VPN, router, route table, network adapter, DNS, hosts, and DoH configuration are reminder-only. Product code and lifecycle tests must never modify them.
- The Windows product uses a private Node 24 runtime, Tauri v2/WebView2 shell, native constrained helper, and a per-user Inno Setup installer.
- Public artifacts require matching version/commit/toolchain locks, SHA-256, CycloneDX SBOM, evidence, Windows lifecycle results, and an explicit signing state.

See [README.md](README.md) for user commands and actual installation behavior.
