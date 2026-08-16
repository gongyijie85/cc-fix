// 追加式操作日志存储（T14）：JSONL 读写，损坏行跳过，写失败返回 false（观测降级，不撤销已提交目标）。
import fs from "node:fs/promises";
import path from "node:path";
import { defaultPersistRoot } from "../state/paths.js";
import {
  parseHistoryLine,
  serializeHistoryRecord,
  type HistoryRecordV2,
} from "./schema.js";

/** 日志文件路径；root 可注入（测试传临时目录），默认唯一推导点 state/paths.defaultPersistRoot。 */
export function historyFilePath(root: string = defaultPersistRoot(process.env)): string {
  return path.join(root, "history.jsonl");
}

/**
 * 追加一条 v2 记录。写失败不抛出、不撤销任何已提交目标——操作日志是观测层，
 * 失败只作为观测降级上报（返回 false 供调用方提示）。
 */
export async function appendHistoryRecord(record: HistoryRecordV2, root?: string): Promise<boolean> {
  try {
    const file = historyFilePath(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, serializeHistoryRecord(record) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** 返回最近 limit 条，最新在前；损坏的行与无法解析的记录跳过。 */
export async function readHistoryRecords(limit = 10, root?: string): Promise<HistoryRecordV2[]> {
  let content: string;
  try {
    content = await fs.readFile(historyFilePath(root), "utf-8");
  } catch {
    return [];
  }

  const entries: HistoryRecordV2[] = [];
  for (const line of content.split("\n")) {
    const parsed = parseHistoryLine(line);
    if (parsed !== null) entries.push(parsed);
  }
  return entries.slice(-limit).reverse();
}
