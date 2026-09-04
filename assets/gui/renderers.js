/**
 * DOM-only renderers for transient GUI panels. Network/SSE orchestration stays
 * in app.js so these functions remain a small, explicit view boundary.
 */

/** HTML-escapes untrusted text before interpolation into innerHTML templates. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function describeFontStatus(status) {
  const found = status.found || [];
  if (found.length > 0) {
    return `发现 ${found.length} 个中文字体：${found.slice(0, 3).join(", ")}${found.length > 3 ? "…" : ""}`;
  }
  return "中文字体已移除";
}

export function createPanelRenderer({ select, riskLabels, onDetectDone, onFontRefresh }) {
  function showDetectStart(signals) {
    select("#detectCard").classList.add("visible");
    select("#detectTitle").textContent = "检测进行中…";
    const list = select("#detectList");
    list.innerHTML = "";
    for (const signal of signals) {
      list.insertAdjacentHTML("beforeend", `
        <div class="detect-row" id="detect-${escapeHtml(signal.id)}">
          <div class="detect-label">${escapeHtml(signal.label)}</div>
          <div class="detect-value detect-pending" id="dv-${escapeHtml(signal.id)}">检测中…</div>
          <div class="detect-status" id="ds-${escapeHtml(signal.id)}"></div>
        </div>`);
    }
  }

  function showDetectSignal(signal) {
    const value = document.getElementById(`dv-${signal.id}`);
    const status = document.getElementById(`ds-${signal.id}`);
    const row = document.getElementById(`detect-${signal.id}`);
    if (!value || !status || !row) return;

    value.textContent = signal.value || "N/A";
    value.classList.remove("detect-pending");
    const risk = Object.hasOwn(riskLabels, signal.risk) ? signal.risk : "unknown";
    const riskText = Object.hasOwn(riskLabels, signal.risk) ? riskLabels[signal.risk] : "未知";
    status.innerHTML = `<span class="risk-badge risk-${escapeHtml(risk)}">${escapeHtml(riskText)}</span>`;
    row.classList.add("detect-flash");
  }

  function showDetectDone(response) {
    select("#detectTitle").textContent = "检测完成";
    setTimeout(() => select("#detectCard").classList.remove("visible"), 1500);
    onDetectDone(response);
  }

  function showFontsStatus(status) {
    const panel = document.getElementById("fontsPanel");
    if (!panel) return;
    if (!status.found.length && !status.backedUp) {
      panel.classList.remove("visible");
      return;
    }

    panel.classList.add("visible");
    const text = document.getElementById("fontsStatus");
    if (text) {
      text.textContent = describeFontStatus(status);
      const pending = status.pendingReboot || [];
      if (pending.length > 0) text.textContent += `（${pending.length} 个待重启删除）`;
    }
    document.getElementById("btnFontsRestore")?.classList.toggle("is-visible", Boolean(status.backedUp));
  }

  function showFontsEvent(event) {
    const text = document.getElementById("fontsStatus");
    if (!text) return;
    if (event.type === "step-start") text.textContent = "字体处理中…（如弹出 UAC 请确认）";
    else if (event.type === "step-ok") {
      text.textContent = "字体操作完成";
      onFontRefresh();
    } else if (event.type === "step-fail") text.textContent = `字体操作失败：${event.error || ""}`;
    else if (event.type === "fonts-done") {
      if (event.pendingReboot?.length > 0) text.textContent = `完成；${event.pendingReboot.length} 个文件需重启后删除：${event.pendingReboot.join(", ")}`;
      onFontRefresh();
    }
  }

  return { showDetectStart, showDetectSignal, showDetectDone, showFontsStatus, showFontsEvent };
}
