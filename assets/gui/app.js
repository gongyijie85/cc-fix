import { initialUiState, reduceUiState } from "./state.js";
import { createPanelRenderer, escapeHtml } from "./renderers.js";

const $ = (s) => document.querySelector(s);
const esc = escapeHtml;
const riskLabel = { low: "安全", medium: "中风险", high: "高风险", critical: "极高风险" };
const scoreClass = (s) => s >= 71 ? "score-critical" : s >= 51 ? "score-high" : s >= 21 ? "score-medium" : "score-low";

// ── 检测信号占位表（13 行） ──
let DETECT_SIGNALS = [
  { id: "timezone", label: "时区" },
  { id: "language", label: "语言" },
  { id: "locale", label: "Locale" },
  { id: "consistency", label: "一致性" },
  { id: "fonts", label: "字体" },
  { id: "dns", label: "DNS" },
  { id: "base-url", label: "Base URL" },
  { id: "proxy-env", label: "代理环境" },
  { id: "win-region", label: "Windows 区域" },
  { id: "utc-offset", label: "UTC 偏移" },
  { id: "browser-policy", label: "浏览器策略" },
  { id: "ip-datacenter", label: "数据中心 IP" },
  { id: "ip-multi-source", label: "多源不一致" },
];

// 服务端 catalog 事件到达后替换硬编码回退表（服务端为唯一定义，评审候选 7）
function applySignalCatalog(signals) {
  if (Array.isArray(signals) && signals.length > 0) DETECT_SIGNALS = signals;
}

let uiState = initialUiState;
let currentMode = "daily";
const dispatchUi = (action) => (uiState = reduceUiState(uiState, action));

// #89 渲染收敛：会话级 regions 缓存（首次成功即记忆，失败可重试）+ 用户手动地区选择跟踪。
// renderDetectResult 局部补丁时不再重拉 regions/status；用户选中的地区不被 loadStatus 覆盖。
let cachedRegions = null;
let userPickedRegion = null;
function trackRegionPick() {
  const sel = document.getElementById("regionSelect");
  if (sel) sel.addEventListener("change", () => { userPickedRegion = sel.value; });
}

// ── Toast ──
function showToast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2000);
}


// ── 修复流卡片 ──
function ensureFixCard() {
  const card = $("#fixCard");
  card.classList.add("visible");
  $("#fixTitle").textContent = "修复进行中…";
  $("#stepList").innerHTML = "";
  $("#sumBar").style.display = "none";
  $("#sumBar").innerHTML = "";
  const hint = $("#browserHint");
  hint.classList.remove("visible", "strong");
  hint.textContent = "";
  // #113：降级提示与浏览器重启提示分属不同区域，启动修复时两者都清空
  const degraded = $("#degradedHint");
  if (degraded) { degraded.classList.remove("visible", "strong"); degraded.textContent = ""; }
  const fatal = $("#fatalCta");
  if (fatal) fatal.hidden = true;
}

// #118：页内确认对话框（替代阻塞 confirm()，键盘/读屏可访问）
function showConfirmDialog({ title, lines, confirmText = "继续" }) {
  return new Promise((resolve) => {
    const dialog = document.getElementById("confirmDialog");
    if (!dialog || typeof dialog.showModal !== "function") { resolve(true); return; }
    document.getElementById("confirmTitle").textContent = title;
    const body = document.getElementById("confirmBody");
    body.textContent = "";
    for (const line of lines) {
      const p = document.createElement("p");
      p.textContent = line;
      body.appendChild(p);
    }
    document.getElementById("confirmOk").textContent = confirmText;
    const ok = document.getElementById("confirmOk");
    const cancel = document.getElementById("confirmCancel");
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onOk = () => settle(true);
    const onCancel = () => settle(false);
    const onClose = () => settle(false); // Escape / 其它关闭路径视为取消
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    cancel.focus();
  });
}

// 首次标准保护确认只弹一次（规格：首次 standard 显示一次影响确认；deep 每次进入/升级都确认）
const STANDARD_CONFIRMED_KEY = "cc-fix-standard-confirmed-v1";

// #113/#114 可访问性基础：禁用态同步 aria-disabled；截断的检测值可复制
function setButtonsDisabled(d) {
  ["btnOn", "btnOff", "btnRecover", "btnRefresh", "btnFontsRestore", "regionSelect", "levelSelect"].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled = d; el.setAttribute("aria-disabled", String(d)); }
  });
}

function copyToClipboard(text) {
  const done = () => showToast("已复制到剪贴板");
  if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).then(done, () => done()); }
  else done();
}

function addStepRow(event) {
  const list = $("#stepList");
  const changeHtml = event.oldValue !== undefined
    ? `<div class="step-change">${esc(event.oldValue)} → <b>${esc(event.newValue)}</b></div>`
    : "";
  const rollbackClass = event.rollback ? " rollback" : "";
  list.insertAdjacentHTML("beforeend", `
    <div class="step-row" id="step-${esc(event.stepId)}">
      <div class="step-circle running${rollbackClass}" id="circle-${esc(event.stepId)}">…</div>
      <div class="step-body">
        <div class="step-name">${esc(event.name)}</div>
        ${changeHtml}
      </div>
    </div>`);
}

function updateStep(stepId, status, rollback, error) {
  const circle = document.getElementById(`circle-${stepId}`);
  const row = document.getElementById(`step-${stepId}`);
  if (!circle || !row) return;

  const isRollback = rollback || circle.classList.contains("rollback");
  circle.classList.remove("running");

  if (status === "ok") {
    circle.className = `step-circle ok${isRollback ? " rollback" : ""}`;
    circle.textContent = "✓";
    const badge = document.createElement("span");
    badge.className = `step-badge ${isRollback ? "badge-rollback" : "badge-ok"}`;
    badge.textContent = isRollback ? "已回滚" : "成功";
    const body = row.querySelector(".step-body");
    body.appendChild(badge);
  } else {
    circle.className = "step-circle fail";
    circle.textContent = "✗";
    const badge = document.createElement("span");
    badge.className = "step-badge badge-fail";
    badge.textContent = "失败";
    const body = row.querySelector(".step-body");
    body.appendChild(badge);
    if (error) {
      const errBox = document.createElement("div");
      errBox.className = "err-box";
      errBox.textContent = error;
      body.appendChild(errBox);
    }
  }
}

function showSummary(event) {
  const bar = $("#sumBar");
  bar.style.display = "flex";
  let html = `<span class="count sum-ok">${event.ok} 成功</span>`;
  if (event.fail > 0) html += `<span class="count sum-fail">${event.fail} 失败</span>`;
  if (event.rolledBack) html += `<span class="count sum-rollback">已回滚</span>`;
  if (event.degraded && event.degraded.length > 0) html += `<span class="count sum-degraded">降级 ${event.degraded.length} 项</span>`;
  bar.innerHTML = html;

  const title = $("#fixTitle");
  if (event.fatal) {
    title.textContent = "修复失败，需手动检查";
    title.style.color = "var(--red)";
  } else if (event.rolledBack) {
    title.textContent = "修复失败，已恢复原状";
    title.style.color = "var(--orange)";
  } else if (event.degraded && event.degraded.length > 0) {
    title.textContent = "修复完成（部分浏览器策略降级）";
    title.style.color = "var(--orange)";
  } else {
    title.textContent = "修复完成";
    title.style.color = "var(--green)";
  }

  // #110：fatal（事务未收敛/recovery_required）时给出可执行的恢复/还原入口
  const fatalCta = $("#fatalCta");
  if (fatalCta) {
    if (event.fatal) {
      fatalCta.hidden = false;
      const note = $("#fatalCtaText");
      if (note) note.textContent = "事务未收敛。可先尝试「继续恢复」收敛补偿，或直接「还原日常配置」；若反复失败请查看诊断日志后重试。";
    } else {
      fatalCta.hidden = true;
    }
  }

  setButtonsDisabled(false);

  // 浏览器策略生效提示：on 流写入策略后显示；off 后消失（ADR-0003）
  const hint = $("#browserHint");
  if (uiState.lastFixAction === "off") {
    hint.classList.remove("visible", "strong");
    hint.textContent = "";
  } else if (uiState.lastFixAction === "on" && uiState.pendingBrowserHint !== null && !event.fatal) {
    const running = uiState.pendingBrowserHint;
    hint.classList.add("visible");
    if (running.length > 0) {
      // 浏览器运行中：加强显示，新策略不会立即生效
      hint.classList.add("strong");
      const names = running.map(b => b === "chrome" ? "Chrome" : "Edge").join("、");
      hint.textContent = `浏览器策略已写入，但检测到 ${names} 正在运行 — 请重启浏览器后新策略才生效`;
    } else {
      hint.classList.remove("strong");
      hint.textContent = "浏览器策略已写入，请重启 Chrome/Edge 生效";
    }
  }
  dispatchUi({ type: "fix-complete" });

  // 成功后自动复测（评分对比由服务端 recheck 事件推送）
  if (event.fail === 0) {
    setTimeout(() => startCheck(), 500);
  }
}

function showScoreDelta(before, after) {
  const bar = $("#sumBar");
  bar.insertAdjacentHTML("beforeend",
    `<span class="score-delta">${before} → ${after}</span>`);
}

// ── 最近操作 ──
const historyActionLabel = { "persist-on": "一键切换到安全环境", "persist-off": "一键还原日常配置", "check": "重新检测", "font-remove": "移除中文字体", "font-restore": "还原中文字体" };

function renderHistoryRow(entry) {
  const time = new Date(entry.timestamp);
  const timeStr = isNaN(time)
    ? esc(entry.timestamp)
    : time.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const label = historyActionLabel[entry.action] || esc(entry.action);
  const counts = entry.counts;
  let result, cls = "";
  if (entry.action === "check") {
    result = `评分 ${entry.score ?? "-"}`;
  } else if (entry.action === "font-remove" || entry.action === "font-restore") {
    result = "已记录";
  } else if (entry.outcome === "recovery_required") {
    result = "需恢复"; cls = "fail";
  } else if (entry.outcome === "compensated") {
    result = "已回滚"; cls = "fail";
  } else if (entry.outcome === "noop") {
    result = "无变化"; cls = "ok";
  } else if (entry.outcome === "failed") {
    result = counts ? `${counts.ok} 成功 · ${counts.fail} 失败` : "失败"; cls = "fail";
  } else if (entry.outcome === "degraded") {
    result = counts ? `${counts.ok} 成功 · 降级 ${counts.fail} 项` : "降级完成"; cls = "ok";
  } else {
    result = counts ? `${counts.ok} 成功` : "成功"; cls = "ok";
  }
  return `<div class="history-row"><span class="history-time">${timeStr}</span><span class="history-action">${label}</span><span class="history-result ${cls}">${esc(result)}</span></div>`;
}

async function loadHistory() {
  try {
    const res = await fetch("/api/history");
    if (!res.ok) return;
    const entries = await res.json();
    $("#historyList").innerHTML = entries.length
      ? entries.map(renderHistoryRow).join("")
      : `<div class="history-empty">暂无操作记录</div>`;
  } catch { /* 面板为辅助功能，失败不阻断 */ }
}

const panelRenderer = createPanelRenderer({
  select: $,
  riskLabels: riskLabel,
  onDetectDone: renderDetectResult,
  onFontRefresh: loadFontsStatus,
});

// ── 事件处理 ──
// ── 字体修复流（ADR-0013）──
async function loadFontsStatus() {
  try {
    const res = await fetch("/api/fonts/status");
    if (!res.ok) return;
    const s = await res.json();
    panelRenderer.showFontsStatus(s);
  } catch {}
}
async function fontsRestore() {
  try {
    const res = await fetch("/api/fonts/restore", { method: "POST" });
    if (res.status === 409) { showToast("已有操作进行中，请稍候后再试…"); return; }
    if (!res.ok) { showToast("字体操作启动失败（HTTP " + res.status + "）"); }
  } catch { showToast("无法连接本地服务"); }
}
function handleEvent(event) {
  if (event.type === "fonts-done") { panelRenderer.showFontsEvent(event); return; }
  if (event.stepId === "fonts") { panelRenderer.showFontsEvent(event); return; }
  if (event.type === "step-start") {
    if (!uiState.fixActive) {
      ensureFixCard();
      dispatchUi({ type: "fix-start" });
    }
    addStepRow(event);
  }
  else if (event.type === "step-ok") { updateStep(event.stepId, "ok", event.rollback); }
  else if (event.type === "step-fail") { updateStep(event.stepId, "fail", event.rollback, event.error); }
  else if (event.type === "summary") { showSummary(event); loadHistory(); }
  else if (event.type === "catalog") { applySignalCatalog(event.signals); }
  else if (event.type === "browser-hint") { dispatchUi({ type: "browser-hint", running: event.running }); }
  else if (event.type === "recheck") { showScoreDelta(event.before, event.after); }
  else if (event.type === "detect-start") { panelRenderer.showDetectStart(DETECT_SIGNALS); }
  else if (event.type === "detect-ok") { panelRenderer.showDetectSignal(event.signal); }
  else if (event.type === "detect-done") {
    panelRenderer.showDetectDone(event.response);
    loadHistory();
    // fix 完成后的自动复测刷新状态点/模式/恢复提示（纯检测周期不产生 refetch）
    if (uiState.lastFixAction !== null) {
      loadStatus();
      dispatchUi({ type: "fix-synced" });
    }
  }
  else if (event.type === "phase") {
    // 阶段提示（如 IP 情报获取中）
    if (!document.getElementById("detectCard").classList.contains("visible")) {
      panelRenderer.showDetectStart(DETECT_SIGNALS);
    }
  }
}

// ── SSE 连接 ──
const evtSource = new EventSource("/api/events");
let sseOpen = false;
let pendingStart = false;
let sseFailures = 0;
evtSource.onopen = () => {
  sseOpen = true;
  sseFailures = 0;
  const retryBtn = document.getElementById("btnSseRetry");
  if (retryBtn) retryBtn.hidden = true;
  // SSE 就绪前发起的检测请求补发，避免事件丢失导致界面停在"检测进行中…"
  if (pendingStart) { pendingStart = false; startCheck(); }
};
evtSource.onmessage = (e) => {
  try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error("事件处理错误:", err); }
};
evtSource.onerror = () => {
  sseOpen = false;
  sseFailures += 1;
  // 连续失败：服务不可达或会话失效。EventSource 仍会重连，成功后自动清除提示并补发检测。
  const retryBtn = document.getElementById("btnSseRetry");
  if (sseFailures >= 3) {
    const loadingText = document.querySelector("#content .loading p");
    if (loadingText) loadingText.textContent = "无法连接本地服务或会话已失效";
    if (retryBtn) retryBtn.hidden = false;
  }
  // #110：恢复连接后隐藏重试入口（onopen 也会归零失败计数）
};
if (document.getElementById("btnSseRetry")) {
  document.getElementById("btnSseRetry").addEventListener("click", () => { window.location.reload(); });
}

// ── 操作按钮 ──
async function persistOn() {
  const region = document.getElementById("regionSelect")?.value || "us";
  // #105：level 缺省不回落 standard——未选择/状态未就绪时省略参数，服务端按当前模式
  // 解析（保持强度），杜绝 deep 用户在 status 回填前被意外降级。
  const levelSel = document.getElementById("levelSelect");
  const level = levelSel?.value || "";
  // #118：页内对话框确认。standard（显式或默认）首次一次；deep 每次进入/升级都确认。
  if (level === "deep") {
    const ok = await showConfirmDialog({
      title: "进入深度保护？",
      lines: [
        "深度保护除标准内容外，还会修改 Windows Locale、首选语言列表与用户 Culture，日常使用界面语言/区域会随之变化。",
        "关闭保护时会从耐久备份完整还原原始设置。",
        `目标：深度保护 / ${region.toUpperCase()}`,
      ],
      confirmText: "进入深度保护",
    });
    if (!ok) return;
  } else if (currentMode === "daily" && !localStorage.getItem(STANDARD_CONFIRMED_KEY)) {
    const ok = await showConfirmDialog({
      title: "开启标准保护？",
      lines: [
        "将修改：用户环境变量（TZ/LANG/LC_ALL）、Windows 系统时区，以及 Chrome/Edge 的 6 个受管策略槽。",
        "VPN、路由、DNS 等网络配置不会被修改；关闭保护可完整还原。",
        `目标：标准保护 / ${region.toUpperCase()}`,
      ],
      confirmText: "开启标准保护",
    });
    if (!ok) return;
    try { localStorage.setItem(STANDARD_CONFIRMED_KEY, "1"); } catch { /* 隐私模式等场景降级为每次询问 */ }
  }
  setButtonsDisabled(true);
  dispatchUi({ type: "fix-action", action: "on" });
  const levelParam = level ? `&level=${encodeURIComponent(level)}` : "";
  const res = await fetch(`/api/fix/on?region=${encodeURIComponent(region)}${levelParam}`, { method: "POST" });
  if (!res.ok) {
    setButtonsDisabled(false);
    showToast("已有操作进行中，请稍候");
  }
  // 事件流驱动 UI 更新
}

async function persistRecover() {
  setButtonsDisabled(true);
  dispatchUi({ type: "fix-action", action: "recover" });
  const res = await fetch("/api/fix/recover", { method: "POST" });
  if (!res.ok) {
    setButtonsDisabled(false);
    showToast("已有操作进行中，请稍候");
  }
}

async function persistOff() {
  setButtonsDisabled(true);
  dispatchUi({ type: "fix-action", action: "off" });
  const res = await fetch("/api/fix/off", { method: "POST" });
  if (!res.ok) {
    setButtonsDisabled(false);
    showToast("已有操作进行中，请稍候");
  }
}

function startCheck() {
  if (!sseOpen) { pendingStart = true; return; }
  $("#detectCard").classList.add("visible");
  // #109：首帧 onboarding 处于 #content 时更新其进行中提示
  const obRunning = $("#obRunning");
  if (obRunning) obRunning.textContent = "检测进行中，结果就绪后自动展示…";
  fetch("/api/check/start", { method: "POST" }).then(res => {
    if (!res.ok) {
      $("#detectCard").classList.remove("visible");
      const loadingText = document.querySelector("#content .loading p");
      const message = res.status === 409
        ? "已有操作进行中，请稍候后再试…"
        : res.status === 401
          ? "会话未授权，请关闭后重新打开应用"
          : `检测启动失败（HTTP ${res.status}）`;
      if (loadingText) loadingText.textContent = message;
      showToast(message);
    }
  });
}

function refresh() {
  $("#content").innerHTML = '<div class="loading"><div class="spinner"></div><p>正在检测...</p></div>';
  startCheck();
}

// ── 原有渲染逻辑 ──
const REGION_LABELS = { us: "美国", eu: "欧洲", jp: "日本", sg: "新加坡" };

// 地区选项来自服务端（与 CLI --region 同一事实源）；失败时保留静态 us 项。
// #89 渲染收敛：一次会话仅请求一次 /api/regions（首个成功结果即缓存），每次调用复用缓存填充，
// 但缓存失败不记（下次可重试），且不覆盖用户已选的地区。
async function loadRegions() {
  const sel = document.getElementById("regionSelect");
  if (!sel) return;
  try {
    if (!cachedRegions) {
      const res = await fetch("/api/regions");
      if (!res.ok) return;
      cachedRegions = await res.json();
    }
    sel.innerHTML = cachedRegions.regions.map(r => `<option value="${esc(r.code)}">${REGION_LABELS[r.code] || esc(r.code)}</option>`).join("");
    if ((!sel.value || !cachedRegions.regions.some(r => r.code === sel.value)) && userPickedRegion === null) sel.value = cachedRegions.default;
  } catch { /* 回落静态选项 */ }
}

async function loadStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) {
      const dot = $("#statusDot"), txt = $("#statusText");
      dot.className = "status-dot off";
      txt.textContent = res.status === 401 ? "会话未授权，请关闭后重新打开应用" : `服务异常（HTTP ${res.status}）`;
      setButtonsDisabled(false);
      return;
    }
    const status = await res.json();
    const dot = $("#statusDot"), txt = $("#statusText");
    if (!status || typeof status.mode !== "string") {
      dot.className = "status-dot off";
      txt.textContent = "状态数据异常";
      setButtonsDisabled(false);
      return;
    }
    currentMode = status.mode;
    if (status.mode !== "daily") { dot.className = "status-dot on"; txt.textContent = `${status.mode} · ${status.health}`; }
    else { dot.className = "status-dot off"; txt.textContent = `daily · ${status.health}`; }
    // #111：状态栏独立呈现生效/偏好地区与未完成事务；title 附 revision/updatedAt
    const statusDetail = $("#statusDetail");
    if (statusDetail) {
      const detailParts = [];
      if (status.mode !== "daily" && status.target?.region) detailParts.push(`生效:${status.target.region}`);
      detailParts.push(`偏好:${status.preferredRegion || "us"}`);
      const txKind = status.transaction?.kind;
      if (txKind && txKind !== "none") detailParts.push(`事务:${txKind}`);
      statusDetail.textContent = detailParts.length > 0 ? `｜${detailParts.join(" · ")}` : "";
    }
    const statusBar = document.querySelector(".status-bar");
    if (statusBar) {
      statusBar.setAttribute("title", `mode=${status.mode} · health=${status.health} · revision=${status.revision ?? "?"} · updatedAt=${status.updatedAt ?? "?"}`);
    }
    const regionModeLabel = $("#regionModeLabel");
    if (regionModeLabel) {
      regionModeLabel.textContent = status.mode === "daily"
        ? "偏好地区（日常模式，下次保护/未显式检测默认）"
        : "生效地区（已提交；更改将发起保护目标切换）";
    }
    const sel = document.getElementById("regionSelect");
    const hint = document.getElementById("regionHint");
    // #89 地区选择保留：loadStatus 仅在用户未手动选择时设置默认地区，绝不覆盖用户选择。
    if (sel) { sel.disabled = false; if (userPickedRegion === null) sel.value = status.target?.region || status.preferredRegion || "us"; }
    const level = document.getElementById("levelSelect");
    if (level && status.mode !== "daily") level.value = status.mode;
    const needsRecovery = status.transaction?.kind !== "none" || status.health === "recovery_required";
    if (hint) { hint.style.display = needsRecovery ? "inline" : "none"; hint.textContent = "存在未完成事务，请先恢复"; }
    // 未对齐策略槽（ADR-0011 每槽降级）：逐槽展示
    // #113：持久降级提示写入独立 #degradedHint（不再与"重启浏览器"瞬态提示共用 #browserHint；
    // #browserHint 生命周期由 showSummary / browser-hint 事件维护，loadStatus 不清空它）
    const degradedHint = $("#degradedHint");
    const POLICY_SLOT_LABELS = {
      "chrome.accept_language": "Chrome/AcceptLanguage", "chrome.webrtc": "Chrome/WebRTC 防泄漏", "chrome.application_locale": "Chrome/ApplicationLocale",
      "edge.accept_language": "Edge/AcceptLanguage", "edge.webrtc": "Edge/WebRTC 防泄漏", "edge.application_locale": "Edge/ApplicationLocale",
    };
    const unaligned = Array.isArray(status.degradation) ? status.degradation.map(d => POLICY_SLOT_LABELS[d.slot] || d.slot) : [];
    if (degradedHint) {
      if (status.health === "degraded" && unaligned.length > 0) {
        const causes = [...new Set((status.degradation || []).map(d => d.cause))].join("/");
        degradedHint.textContent = "策略槽未对齐（可能受组织策略管理）：" + unaligned.join("、") + (causes ? "（原因：" + (causes === "access_denied" ? "写入被拒绝——安全软件的注册表防护可能阻止了写入（如火绒的注册表防护），请在防护中心放行或关闭后重试" : causes) + "）" : "");
        degradedHint.classList.add("visible", "strong");
      } else {
        degradedHint.classList.remove("visible", "strong");
        degradedHint.textContent = "";
      }
    }
    const recover = document.getElementById("btnRecover");
    if (recover) recover.classList.toggle("is-visible", needsRecovery);
    // #105：首次 status 就绪前操作控件保持禁用（levelSelect 已按当前模式初始化后才可操作）
    setButtonsDisabled(false);
  } catch {
    const dot = $("#statusDot"), txt = $("#statusText");
    dot.className = "status-dot off";
    txt.textContent = "无法连接本地服务";
    setButtonsDisabled(false);
  }
}

// ── 渲染拆分（#89 渲染收敛）：检测结果局部补丁 vs 首次/刷新全量构建 ──
// buildDetectResultHtml：仅生成 score-card + ip-info + signals 片段（detect-done 局部更新用，不重造选择器/按钮）。
function buildDetectResultHtml(data) {
  const { score, riskLevel, signals, ipIntelligence: ip } = data;
  const sorted = [...signals].sort((a, b) => b.contribution - a.contribution);
  const highCount = signals.filter(s => s.risk === "high" || s.risk === "critical").length;

  const riskText = (level) => Object.hasOwn(riskLabel, level) ? riskLabel[level] : esc(level);
  const riskClass = (level) => Object.hasOwn(riskLabel, level) ? level : "unknown";

  let html = `
    <div class="score-card">
      <div class="score-value ${scoreClass(score)}">${score}<span class="score-max">/100</span></div>
      <!-- #114：分数档位说明随悬停可见 -->
      <div class="score-label" title="档位：0 安全 · 1-20 低 · 21-50 中 · 51-70 高 · 71+ 极高（分数=各命中信号加权贡献的归一化结果）">风险评分 · ${riskText(riskLevel)}${highCount > 0 ? ` · ${highCount} 个高危` : ""}</div>
    </div>`;

  if (ip) {
    const ipTypeLabel = ip.ipType === "datacenter" ? '<span class="text-danger">数据中心</span>' : ip.ipType === "residential" ? '<span class="text-success">住宅 ISP</span>' : esc(ip.ipType || "N/A");
    const location = [ip.country, ip.city].filter(Boolean).join(" / ");
    html += `<div class="ip-info"><h3><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.9 9h-3.1a16 16 0 0 0-1.2-5A8 8 0 0 1 18.9 11ZM12 4c.9 1.2 1.6 3 1.8 5h-3.6c.2-2 .9-3.8 1.8-5ZM9.4 6a16 16 0 0 0-1.2 5H5.1A8 8 0 0 1 9.4 6ZM5.1 13h3.1a16 16 0 0 0 1.2 5A8 8 0 0 1 5.1 13ZM12 20c-.9-1.2-1.6-3-1.8-5h3.6c-.2 2-.9 3.8-1.8 5Zm2.6-2a16 16 0 0 0 1.2-5h3.1a8 8 0 0 1-4.3 5Z"/></svg> 网络出口</h3><div class="ip-grid">
      <div class="ip-item"><span>IP:</span> ${esc(ip.ip || "N/A")}</div>
      <div class="ip-item"><span>位置:</span> ${esc(location || "N/A")}</div>
      <div class="ip-item"><span>ASN:</span> ${esc(ip.asn || "N/A")}</div>
      <div class="ip-item"><span>类型:</span> ${ipTypeLabel}</div>
      <div class="ip-item"><span>多源:</span> ${ip.multiSourceConsistent ? '<span class="text-success">一致</span>' : '<span class="text-danger">不一致</span>'}</div>
    </div></div>`;
  }

  html += `<div class="signals"><h3>检测信号 (${signals.length})</h3><table><thead><tr><th>检测项</th><th>当前值</th><th>风险</th><th title="贡献分值 / 该信号权重（命中即贡献此分值，权重反映风险等级）">分值</th></tr></thead><tbody>`;
  for (const s of sorted) {
    const truncated = s.value && s.value.length > 30;
    const val = truncated ? s.value.slice(0, 30) + "..." : (s.value || "N/A");
    const fullValue = s.value || "N/A";
    const contribTitle = `贡献 ${s.contribution || 0} / 权重 ${s.weight ?? "?"}（命中即贡献此值，权重反映该风险等级的重要性）`;
    // #113/#114：title 显示完整值；点击值单元格复制（事件委托，兼容 CSP script-src 'self'）
    html += `<tr><td>${esc(s.label)}</td><td class="signal-value" title="${esc(fullValue)}" data-full="${esc(fullValue)}">${esc(val)}</td><td><span class="risk-badge risk-${riskClass(s.risk)}">${riskText(s.risk)}</span></td><td class="contrib ${s.contribution > 0 ? "contrib-nonzero" : "contrib-zero"}" title="${esc(contribTitle)}">${s.contribution > 0 ? "+" + s.contribution : "+0"}</td></tr>`;
  }
  html += `</tbody></table></div>`;
  return html;
}

function recommendationsFragment(recommendations) {
  if (!Array.isArray(recommendations) || recommendations.length === 0) return "";
  let html = `<h3>修复建议</h3><ul>`;
  for (const r of recommendations) html += `<li>${esc(r)}</li>`;
  html += `</ul>`;
  return html;
}

// renderFullContent：首次绘制/刷新后的全量构建（含选择器、按钮、网络说明与修复建议容器）。
function renderFullContent(data) {
  const { recommendations } = data;
  // 重建前保存用户已选地区（#detectResult 存在时才有可读的 select；刷新后由 userPickedRegion 兜底）
  const prevSel = document.getElementById("regionSelect");
  const savedRegion = userPickedRegion !== null ? userPickedRegion : (prevSel ? (prevSel.value || null) : null);

  let html = `<div id="detectResult">${buildDetectResultHtml(data)}</div>`;

  html += `<div class="region-select">
    <label for="regionSelect"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.9 9h-3.1a16 16 0 0 0-1.2-5A8 8 0 0 1 18.9 11ZM12 4c.9 1.2 1.6 3 1.8 5h-3.6c.2-2 .9-3.8 1.8-5ZM9.4 6a16 16 0 0 0-1.2 5H5.1A8 8 0 0 1 9.4 6ZM5.1 13h3.1a16 16 0 0 0 1.2 5A8 8 0 0 1 5.1 13ZM12 20c-.9-1.2-1.6-3-1.8-5h3.6c-.2 2-.9 3.8-1.8 5Zm2.6-2a16 16 0 0 0 1.2-5h3.1a8 8 0 0 1-4.3 5Z"/></svg> 目标地区</label>
    <label for="regionSelect" class="visually-hidden">目标地区</label>
    <select id="regionSelect" aria-label="目标地区"><option value="us">美国</option></select>
    <label for="levelSelect"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Z"/></svg> 保护强度</label>
    <label for="levelSelect" class="visually-hidden">保护强度</label>
    <select id="levelSelect" aria-label="保护强度"><option value="standard">标准（推荐）</option><option value="deep">深度</option></select>
    <span class="region-mode" id="regionModeLabel"></span>
    <span class="region-hint" id="regionHint">存在未完成事务，请先恢复</span>
  </div>`;

  html += `<div class="actions">
    <button class="btn btn-on" id="btnOn"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Z"/></svg> 一键切换到安全环境<small>persist on</small></button>
    <button class="btn btn-off" id="btnOff"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M3 11 12 4l9 7v8h-6v-5H9v5H3v-8Zm9-4.4L6 11v5h1v-5h10v5h1v-5l-7-4.4Z"/></svg> 一键还原日常配置<small>persist off</small></button>
    <button class="btn btn-off" id="btnRecover">继续恢复<small>persist recover</small></button>
    <button class="btn btn-refresh" id="btnRefresh">重新检测</button>
  </div>`;

  html += `<p class="network-note">VPN、路由器、网卡、DNS、hosts 与 DoH 仅做检测和提醒，CC-Fix 不会修改这些网络配置。检测会向 ipwho.is / ipinfo.io 查询出口 IP 以判断风险（仅公网 IP 与国家/ASN 信息）。</p>`;

  html += `<div class="recommendations" id="detectRecs"${recommendations && recommendations.length > 0 ? "" : ' style="display:none"'}>${recommendationsFragment(recommendations)}</div>`;

  $("#content").innerHTML = html;
  document.getElementById("btnOn")?.addEventListener("click", persistOn);
  document.getElementById("btnOff")?.addEventListener("click", persistOff);
  document.getElementById("btnRecover")?.addEventListener("click", persistRecover);
  document.getElementById("btnRefresh")?.addEventListener("click", refresh);
  trackRegionPick();
  // #105：控件在首次 loadStatus 按当前模式初始化 levelSelect 前保持禁用，防止
  // deep 用户因默认 standard 选项在竞态窗口内发起意外降级。
  setButtonsDisabled(true);
  // #89 渲染收敛：用户选择保留——loadRegions 填入选项后再恢复 savedRegion（否则无对应 option 会置空）。
  // regions 已缓存（一次会话一次请求），status 仅首次构建时同步一次。
  loadRegions().then(() => {
    const sel = document.getElementById("regionSelect");
    if (sel && savedRegion) sel.value = savedRegion;
    loadStatus();
  });
}

// renderDetectResult：detect-done 局部补丁，仅替换 score/ip/signals 与修复建议容器，
// 不重建选择器与按钮，也不再重拉 /api/regions、/api/status（regions 已缓存，status 被纯检测不变）。
function renderDetectResult(data) {
  if (!document.getElementById("detectResult")) { renderFullContent(data); return; }
  const box = document.getElementById("detectResult");
  box.innerHTML = buildDetectResultHtml(data);
  const recs = document.getElementById("detectRecs");
  const recsHtml = recommendationsFragment(data.recommendations);
  if (recs) {
    if (recsHtml) { recs.innerHTML = recsHtml; recs.style.display = ""; }
    else { recs.innerHTML = ""; recs.style.display = "none"; }
  }
}

// ── 版本页脚（#112）：/api/version 单一事实源；一次会话一次请求，失败静默（不影响主流程）
let footerVersionLoaded = false;
async function loadVersion() {
  if (footerVersionLoaded) return;
  try {
    const res = await fetch("/api/version");
    if (!res.ok) return;
    const info = await res.json();
    if (!info || typeof info.version !== "string") return;
    footerVersionLoaded = true;
    const footer = document.getElementById("appFooter");
    if (footer) footer.textContent = `CC-Fix v${info.version}`;
  } catch { /* 服务未就绪：下次随检测重试 */ }
}

loadStatus();
document.getElementById("btnFontsRestore")?.addEventListener("click", fontsRestore);
// #110：fatal CTA 的恢复/还原入口复用既有流程
document.getElementById("btnFatalRecover")?.addEventListener("click", persistRecover);
document.getElementById("btnFatalOff")?.addEventListener("click", persistOff);
loadFontsStatus();
loadHistory();
loadVersion();
// #113：检测值单元格点击复制（委托，规避 CSP 对内联 handler 的限制）
document.getElementById("content")?.addEventListener("click", (event) => {
  const cell = event.target?.closest?.(".signal-value");
  if (cell && cell.dataset.full) copyToClipboard(cell.dataset.full);
});
startCheck();
