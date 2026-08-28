// 终端表格渲染 — cli-table3 的零依赖替代（strlen/truncate/pad 语义逐字节对齐，消除 267.8 KB 依赖）

// 与 cli-table3 utils.js 相同的 ANSI 颜色码正则（exec 用带捕获组的变体读取控制码）
const ANSI_COLOR_RE = /\u001B\[(?:\d*;){0,5}\d*m/g;
const ANSI_COLOR_CAPTURE_RE = /\u001B\[((?:\d*;){0,5}\d*)m/g;

// string-width v4 语义：emoji 序列先替换为两个空格再计宽。
// 表格单元格内实际出现的 emoji（风险列 ❌/⚠️/✅）与常见 astral emoji 区间。
const EMOJI_RE = /\u26A0\uFE0F?|\u274C|\u2705|[\u{1F000}-\u{1FAFF}]\uFE0F?/gu;

/** is-fullwidth-code-point v3.0.0 的宽度表（East Asian Wide/Fullwidth）。 */
function isFullwidth(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (0x2e80 <= code && code <= 0x3247 && code !== 0x303f) ||
      (0x3250 <= code && code <= 0x4dbf) ||
      (0x4e00 <= code && code <= 0xa4c6) ||
      (0xa960 <= code && code <= 0xa97c) ||
      (0xac00 <= code && code <= 0xd7a3) ||
      (0xf900 <= code && code <= 0xfaff) ||
      (0xfe10 <= code && code <= 0xfe19) ||
      (0xfe30 <= code && code <= 0xfe6b) ||
      (0xff01 <= code && code <= 0xff60) ||
      (0xffe0 <= code && code <= 0xffe6) ||
      (0x1b000 <= code && code <= 0x1b001) ||
      (0x1f200 <= code && code <= 0x1f251) ||
      (0x20000 <= code && code <= 0x3fffd))
  );
}

/** 可见宽度：剥离 ANSI，emoji 按 2 计，全角按 2 计，控制/组合字符按 0 计。 */
export function strlen(text: string): number {
  const stripped = text.replace(ANSI_COLOR_RE, "").replace(EMOJI_RE, "  ");
  let width = 0;
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.codePointAt(i) ?? 0;
    if ((code <= 0x1f || (code >= 0x7f && code <= 0x9f)) || (code >= 0x300 && code <= 0x36f)) {
      continue;
    }
    if (code > 0xffff) i++;
    width += isFullwidth(code) ? 2 : 1;
  }
  return width;
}

function repeat(text: string, times: number): string {
  return times > 0 ? text.repeat(times) : "";
}

// ---- truncate（与 cli-table3 utils.truncate / truncateWidth / truncateWidthWithAnsi 对齐）----

const CODE_CACHE: Record<string, { set: string; to: boolean; on: string; off: string }> = {};

function addToCodeCache(name: string, on: string, off: string): void {
  CODE_CACHE[on] = { set: name, to: true, on, off };
  CODE_CACHE[off] = { set: name, to: false, on, off };
  CODE_CACHE[name] = { set: name, to: true, on, off };
}

addToCodeCache("bold", "\u001B[1m", "\u001B[22m");
addToCodeCache("italics", "\u001B[3m", "\u001B[23m");
addToCodeCache("underline", "\u001B[4m", "\u001B[24m");
addToCodeCache("inverse", "\u001B[7m", "\u001B[27m");
addToCodeCache("strikethrough", "\u001B[9m", "\u001B[29m");

type AnsiState = {
  lastForegroundAdded?: string;
  lastBackgroundAdded?: string;
  [set: string]: boolean | string | undefined;
};

function updateState(state: AnsiState, control: RegExpExecArray): void {
  const controlCode = control[1] ? parseInt(control[1].split(";")[0] ?? "", 10) : 0;
  if ((controlCode >= 30 && controlCode <= 39) || (controlCode >= 90 && controlCode <= 97)) {
    state.lastForegroundAdded = control[0];
    return;
  }
  if ((controlCode >= 40 && controlCode <= 49) || (controlCode >= 100 && controlCode <= 107)) {
    state.lastBackgroundAdded = control[0];
    return;
  }
  if (controlCode === 0) {
    for (const key of Object.keys(state)) delete state[key];
    return;
  }
  const info = CODE_CACHE[control[0]];
  if (info) state[info.set] = info.to;
}

function unwindState(state: AnsiState, ret: string): string {
  const lastBackground = state.lastBackgroundAdded;
  const lastForeground = state.lastForegroundAdded;
  delete state.lastBackgroundAdded;
  delete state.lastForegroundAdded;
  for (const key of Object.keys(state)) {
    if (state[key]) {
      const info = CODE_CACHE[key];
      if (info) ret += info.off;
    }
  }
  if (lastBackground && lastBackground !== "\u001B[49m") ret += "\u001B[49m";
  if (lastForeground && lastForeground !== "\u001B[39m") ret += "\u001B[39m";
  return ret;
}

function truncateWidth(text: string, desiredLength: number): string {
  if (text.length === strlen(text)) return text.slice(0, desiredLength);
  let sliced = text;
  while (strlen(sliced) > desiredLength) sliced = sliced.slice(0, -1);
  return sliced;
}

function truncateWidthWithAnsi(text: string, desiredLength: number): string {
  const code = new RegExp(ANSI_COLOR_CAPTURE_RE.source, "g");
  const parts = text.split(ANSI_COLOR_RE);
  let partIndex = 0;
  let retLen = 0;
  let ret = "";
  const state: AnsiState = {};
  let match: RegExpExecArray | null;
  while (retLen < desiredLength) {
    match = code.exec(text);
    let toAdd = parts[partIndex] ?? "";
    partIndex++;
    if (retLen + strlen(toAdd) > desiredLength) {
      toAdd = truncateWidth(toAdd, desiredLength - retLen);
    }
    ret += toAdd;
    retLen += strlen(toAdd);
    if (retLen < desiredLength) {
      if (!match) break;
      ret += match[0];
      updateState(state, match);
    }
  }
  return unwindState(state, ret);
}

export function truncate(text: string, desiredLength: number, truncateChar = "…"): string {
  if (strlen(text) <= desiredLength) return text;
  const ret = truncateWidthWithAnsi(text, desiredLength - strlen(truncateChar));
  return ret + truncateChar;
}

// ---- 布局 ----

const BORDER_ON = "\u001B[90m"; // colors.grey
const BORDER_OFF = "\u001B[39m";
const HEAD_ON = "\u001B[36m"; // colors.cyan
const HEAD_OFF = "\u001B[39m";

export interface TableOptions {
  head: string[];
  colWidths: number[];
  rows: string[][];
}

function pad(text: string, len: number): string {
  const length = strlen(text);
  if (len + 1 >= length) {
    return text + repeat(" ", len - length);
  }
  return text;
}

// cli-table3 按 cell 分段分别着色边框：\x1b[90m┌───\x1b[39m\x1b[90m┬───\x1b[39m…
function drawBorder(left: string, mid: string, right: string, widths: number[]): string {
  const segments: string[] = [];
  for (let i = 0; i < widths.length; i++) {
    const leftChar = i === 0 ? left : mid;
    const rightChar = i === widths.length - 1 ? right : "";
    segments.push(BORDER_ON + leftChar + "─".repeat(widths[i]!) + rightChar + BORDER_OFF);
  }
  return segments.join("");
}

function drawCellLine(cells: string[], isHead: boolean, widths: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const raw = cells[i] ?? "";
    const contentWidth = (widths[i] ?? 0) - 2;
    let content = truncate(raw, contentWidth);
    content = pad(content, contentWidth);
    content = " " + content + " ";
    if (isHead) content = HEAD_ON + content + HEAD_OFF;
    parts.push(BORDER_ON + "│" + BORDER_OFF + content);
  }
  return parts.join("") + BORDER_ON + "│" + BORDER_OFF;
}

export function renderTable(options: TableOptions): string {
  const { head, colWidths, rows } = options;
  const lines: string[] = [];
  lines.push(drawBorder("┌", "┬", "┐", colWidths));
  lines.push(drawCellLine(head, true, colWidths));
  for (const row of rows) {
    lines.push(drawBorder("├", "┼", "┤", colWidths));
    lines.push(drawCellLine(row, false, colWidths));
  }
  lines.push(drawBorder("└", "┴", "┘", colWidths));
  return lines.join("\n");
}
