import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFile, writeFile } from 'node:fs/promises';
import { appendHistory, readHistory, recordCheck, recordFixSummary, historyFilePath } from './history.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-fix-history-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('operation history', () => {
  it('appends JSONL and reads back newest-first', async () => {
    await recordCheck(42, root);
    await recordFixSummary('persist-on', { ok: 3, fail: 1, rolledBack: false }, root);
    await appendHistory({ timestamp: '2026-01-01T00:00:00.000Z', action: 'check', score: 7 }, root);
    const entries = await readHistory(10, root);
    expect(entries.map(e => e.action)).toEqual(['check', 'persist-on', 'check']);
    expect(entries[1]).toMatchObject({ ok: 3, fail: 1 });
    expect(entries[1]).not.toHaveProperty('rolledBack');
  });

  it('skips corrupt lines without losing the rest', async () => {
    await appendHistory({ timestamp: '2026-01-01T00:00:00.000Z', action: 'check', score: 1 }, root);
    await appendFile(historyFilePath(root), 'not json\n', 'utf-8');
    await appendHistory({ timestamp: '2026-01-01T00:00:01.000Z', action: 'check', score: 2 }, root);
    const entries = await readHistory(10, root);
    expect(entries).toHaveLength(2);
    expect(entries[0].score).toBe(2);
  });

  it('returns empty for a missing log and never throws on write failures', async () => {
    expect(await readHistory(10, root)).toEqual([]);
    // root 指向一个文件占位目录，mkdir 失败但 appendHistory 不抛出
    const blocked = join(root, 'blocked');
    await writeFile(blocked, '占位', 'utf-8');
    await expect(appendHistory({ timestamp: 'x', action: 'check' }, blocked)).resolves.toBeUndefined();
  });
});
