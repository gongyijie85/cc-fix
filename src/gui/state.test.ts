import { describe, expect, it } from "vitest";
import { initialUiState, reduceUiState } from "../../assets/gui/state.js";

describe("GUI fix lifecycle state", () => {
  it("starts a new fix by clearing only the stale browser hint", () => {
    const previous = {
      fixActive: false,
      lastFixAction: "on",
      pendingBrowserHint: ["chrome"],
    };

    expect(reduceUiState(previous, { type: "fix-start" })).toEqual({
      fixActive: true,
      lastFixAction: "on",
      pendingBrowserHint: null,
    });
    expect(previous.pendingBrowserHint).toEqual(["chrome"]);
  });

  it("retains the selected action until the fix completes", () => {
    let state = reduceUiState(initialUiState, { type: "fix-action", action: "on" });
    state = reduceUiState(state, { type: "fix-start" });
    state = reduceUiState(state, { type: "browser-hint", running: ["edge"] });

    expect(state).toEqual({ fixActive: true, lastFixAction: "on", pendingBrowserHint: ["edge"] });
    expect(reduceUiState(state, { type: "fix-complete" })).toEqual({
      fixActive: false,
      lastFixAction: "on",
      pendingBrowserHint: null,
    });
  });

  it("leaves unknown actions unchanged", () => {
    expect(reduceUiState(initialUiState, { type: "unknown" })).toBe(initialUiState);
  });
});
