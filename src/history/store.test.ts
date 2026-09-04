import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistoryRecord, historyFilePath, readHistoryRecords } from "./store.js";
import { HISTORY_SCHEMA_VERSION } from "./schema.js";

// #103：操作日志存储直测（此前仅被 GUI/CLI 间接覆盖）。
function record(action: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    timestamp: "2026-09-04T00:00:00.000Z",
    action,
    outcome: "ok",
    ...overrides,
  } as never;
}

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cc-fix-history-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("history store", () => {
  it("appends records and reads newest-first with the requested limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      await expect(appendHistoryRecord(record("check", { score: i }), root)).resolves.toBe(true);
    }
    const all = await readHistoryRecords(10, root);
    expect(all).toHaveLength(5);
    expect(all[0]).toMatchObject({ action: "check", score: 4 });
    expect(all.at(-1)).toMatchObject({ score: 0 });
    const limited = await readHistoryRecords(2, root);
    expect(limited.map((r) => r.score)).toEqual([4, 3]);
  });

  it("skips corrupt lines without blocking readable records", async () => {
    await appendHistoryRecord(record("check", { score: 1 }), root);
    await appendHistoryRecord(record("persist-on", { score: undefined }), root);
    const file = historyFilePath(root);
    const content = await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8"));
    await writeFile(file, content + "{not json\n", "utf8");
    const records = await readHistoryRecords(10, root);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.action)).toEqual(["persist-on", "check"]);
  });

  it("returns an empty list when the log does not exist", async () => {
    await expect(readHistoryRecords(10, root)).resolves.toEqual([]);
  });

  it("reports false instead of throwing when appends fail", async () => {
    const badRoot = join(root, "missing-sub");
    await mkdir(badRoot, { recursive: true });
    // 指向不可写路径：把 root 指向一个文件名的父级不存在目录（file 路径本身可被 mkdir 兜底，
    // 故改为文件占位阻塞目录创建）
    const occupied = join(root, "blocked");
    await writeFile(occupied, "x", "utf8");
    await expect(appendHistoryRecord(record("check"), join(occupied, "nested"))).resolves.toBe(false);
  });
});
