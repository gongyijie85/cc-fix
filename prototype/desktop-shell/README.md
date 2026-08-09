# CC-Fix desktop shell prototype

> PROTOTYPE — throwaway validation artifact. It is not production code and must not be merged into `main`.

This answers: can the existing CC-Fix HTML/API run inside a normal Windows desktop window without rewriting the detection and repair core, while the CLI remains separate?

## Verdict

Validated on Windows x64 with Tauri 2.11.5, WebView2 and a private Node.js 24.18.1 runtime:

- The existing HTML/API bundle opens in a responsive native window.
- A second launch exits and focuses the existing window; it does not leave another service.
- A requested occupied loopback port is detected and replaced with an ephemeral port.
- Closing the window stops both the shell and its private Node child.
- Shell and service logs are written under LocalAppData.

The selected production shape keeps this lifecycle but adds an authenticated localhost session, native startup/recovery pages, safe-close behavior during mutations, an offline WebView2 prerequisite, and a one-shot privileged helper. The prototype intentionally does not implement those production controls.

## Run

From the repository worktree root:

```powershell
powershell -ExecutionPolicy Bypass -File prototype\desktop-shell\run-prototype.ps1
```

The first build downloads the official Node.js 24.18.1 x64 archive, verifies it against the official `SHASUMS256.txt`, and compiles the Tauri shell. The assembled prototype is under `prototype\desktop-shell\build\portable` and does not use the system Node.js installation at runtime.

## Scenarios to react to

1. Launch the EXE: one CC-Fix window should open with the existing GUI.
2. Launch it again: the existing window should be focused; no second service should remain.
3. Set `CC_FIX_PROTOTYPE_PORT` to an occupied port before launch: the shell should log the conflict and select another loopback port.
4. Close the window: its Node child process should stop.
5. Inspect `%LOCALAPPDATA%\CC-Fix\prototype\logs` for shell and service logs.
6. Optional UAC probe: run the EXE with `--request-elevation`; it should request elevation and relaunch with `--elevated`. This is deliberately not triggered automatically.

## Deliberate limits

- No installer or PATH changes; those belong to the installer specification.
- No production error UI, updater, tray, or background mode.
- The free-port selection has a small bind-then-spawn race; production should add a readiness token and authenticated loopback session.
- The prototype does not change the existing GUI or persist semantics.
