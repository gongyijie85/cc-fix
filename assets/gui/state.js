export const initialUiState = Object.freeze({
  fixActive: false,
  lastFixAction: null,
  pendingBrowserHint: null,
});

/** Pure UI-state reducer: event transport and DOM rendering stay outside this module. */
export function reduceUiState(state, action) {
  switch (action.type) {
    case "fix-start":
      return { ...state, fixActive: true, pendingBrowserHint: null };
    case "fix-complete":
      return { ...state, fixActive: false, pendingBrowserHint: null };
    case "fix-synced":
      // fix 后的复测已刷新 status，清除 lastFixAction 防重复刷新（#89）
      return { ...state, lastFixAction: null };
    case "fix-action":
      return { ...state, lastFixAction: action.action };
    case "browser-hint":
      return { ...state, pendingBrowserHint: action.running };
    default:
      return state;
  }
}
