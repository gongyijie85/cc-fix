import { symlink } from "node:fs/promises";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 创建测试用 reparse point（Windows junction）。真机实录：杀软/Defender 可能短暂锁住
 * 目标目录，导致 symlink() 抛 EBUSY/EPERM/EACCES；此处做有限重试+退避，避免环境瞬时锁
 * 造成测试假失败（测试语义不变）。仅用于测试代码。
 */
export async function createJunctionWithRetry(target: string, link: string, attempts = 6): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
        await sleep(100 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}
