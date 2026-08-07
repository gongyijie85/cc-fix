// 操作日志模块测试 — 追加写入 / 读取 / 损坏行容错

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendHistory, readHistory, recordFixSummary, recordCheck } from "./history.js";

let tmpAppdata: string;
let originalAppdata: string | undefined;

beforeEach(() => {
  originalAppdata = process.env.APPDATA;
  tmpAppdata = fs.mkdtempSync(path.join(os.tmpdir(), "cc-fix-history-"));
  process.env.APPDATA = tmpAppdata;
});

afterEach(() => {
  if (originalAppdata === undefined) {
    delete process.env.APPDATA;
  } else {
    process.env.APPDATA = originalAppdata;
  }
  fs.rmSync(tmpAppdata, { recursive: true, force: true });
});

describe("appendHistory / readHistory", () => {
  it("写入后可读回，最新在前", () => {
    appendHistory({ timestamp: "2026-08-07T01:00:00Z", action: "persist-on", ok: 4, fail: 0 });
    appendHistory({ timestamp: "2026-08-07T02:00:00Z", action: "check", score: 36 });

    const entries = readHistory(10);
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe("check");
    expect(entries[1].action).toBe("persist-on");
  });

  it("只返回最近 limit 条", () => {
    for (let i = 0; i < 15; i++) {
      appendHistory({ timestamp: `2026-08-07T01:${String(i).padStart(2, "0")}:00Z`, action: "check", score: i });
    }
    const entries = readHistory(10);
    expect(entries).toHaveLength(10);
    expect(entries[0].score).toBe(14); // 最新在前
    expect(entries[9].score).toBe(5);
  });

  it("文件不存在时返回空数组", () => {
    expect(readHistory()).toEqual([]);
  });

  it("损坏的单行被跳过，其余条目正常读取", () => {
    appendHistory({ timestamp: "2026-08-07T01:00:00Z", action: "persist-on", ok: 4, fail: 0 });
    // 手动追加一行损坏数据与一行缺少必要字段的数据
    const file = path.join(tmpAppdata, "cc-fix", "history.jsonl");
    fs.appendFileSync(file, "{broken json\n", "utf-8");
    fs.appendFileSync(file, JSON.stringify({ foo: 1 }) + "\n", "utf-8");
    appendHistory({ timestamp: "2026-08-07T02:00:00Z", action: "persist-off", ok: 5, fail: 0 });

    const entries = readHistory(10);
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe("persist-off");
    expect(entries[1].action).toBe("persist-on");
  });

  it("写入失败不抛出（路径非法）", () => {
    // 让 cc-fix 目录位置被一个文件占位，mkdirSync 必然失败
    fs.writeFileSync(path.join(tmpAppdata, "cc-fix"), "占位文件", "utf-8");
    expect(() => appendHistory({ timestamp: "x", action: "check" })).not.toThrow();
  });
});

describe("recordFixSummary / recordCheck", () => {
  it("修复汇总按动作与标志落盘", () => {
    recordFixSummary("persist-on", { ok: 3, fail: 1, rolledBack: true });
    recordFixSummary("persist-off", { ok: 5, fail: 0 });

    const [off, on] = readHistory(10);
    expect(off.action).toBe("persist-off");
    expect(off.ok).toBe(5);
    expect(off.rolledBack).toBeUndefined();
    expect(on.action).toBe("persist-on");
    expect(on.fail).toBe(1);
    expect(on.rolledBack).toBe(true);
  });

  it("fatal 标志落盘", () => {
    recordFixSummary("persist-off", { ok: 1, fail: 1, fatal: true });
    const [entry] = readHistory(10);
    expect(entry.fatal).toBe(true);
  });

  it("检测记录携带评分", () => {
    recordCheck(36);
    const [entry] = readHistory(10);
    expect(entry.action).toBe("check");
    expect(entry.score).toBe(36);
  });
});
