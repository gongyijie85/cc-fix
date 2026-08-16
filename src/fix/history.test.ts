import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFile, writeFile } from 'node:fs/promises';
import {
  appendHistory,
  readHistory,
  recordCheck,
  recordFixSummary,
  recordPersistFacts,
  historyFilePath,
} from './history.js';
import { parseHistoryLine, HISTORY_SCHEMA_VERSION } from '../history/schema.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-fix-history-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('operation history (T14 versioned)', () => {
  it('appends versioned JSONL and reads back newest-first', async () => {
    await recordCheck(42, root);
    await recordFixSummary('persist-on', { ok: 3, fail: 1, rolledBack: false }, root);
    const entries = await readHistory(10, root);
    expect(entries.map(e => e.action)).toEqual(['persist-on', 'check']);
    expect(entries[0]).toMatchObject({ schemaVersion: 2, outcome: 'failed', counts: { ok: 3, fail: 1 } });
    expect(entries[1]).toMatchObject({ schemaVersion: 2, outcome: 'ok', score: 42 });
  });

  it('skips corrupt lines without losing the rest', async () => {
    await recordCheck(1, root);
    await appendFile(historyFilePath(root), 'not json\n', 'utf-8');
    await recordCheck(2, root);
    const entries = await readHistory(10, root);
    expect(entries).toHaveLength(2);
    expect(entries[0].score).toBe(2);
  });

  it('normalizes legacy v1 records into v2', async () => {
    await appendFile(
      historyFilePath(root),
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', action: 'persist-on', ok: 1, fail: 0 }) + '\n',
      'utf-8',
    );
    const entries = await readHistory(10, root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ schemaVersion: 2, action: 'persist-on', outcome: 'ok', counts: { ok: 1, fail: 0 } });
  });

  it('rejects failed-conversion lines (unknown shape) and keeps the rest', async () => {
    await appendFile(
      historyFilePath(root),
      JSON.stringify({ schemaVersion: 99, timestamp: 'x', action: 'check' }) + '\n' +
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', action: 'check', score: 5 }) + '\n',
      'utf-8',
    );
    const entries = await readHistory(10, root);
    expect(entries).toHaveLength(1);
    expect(entries[0].score).toBe(5);
    expect(parseHistoryLine(JSON.stringify({ schemaVersion: 99 }))).toBeNull();
  });

  it('failed requests retain request facts while final facts reflect the still-committed target', async () => {
    // 请求 jp/deep 失败：committed 保持原来的 us/standard
    await recordPersistFacts({
      action: 'persist-on',
      outcome: 'compensated',
      requested: { mode: 'deep', region: 'jp' },
      committed: { mode: 'standard', region: 'us' },
      resolvedRegion: { code: 'jp', source: 'explicit' },
      preferredRegion: 'jp',
      health: 'healthy',
      rolledBack: true,
      counts: { ok: 0, fail: 1 },
    }, root);
    const entries = await readHistory(10, root);
    expect(entries[0]).toMatchObject({
      schemaVersion: 2,
      outcome: 'compensated',
      requested: { mode: 'deep', region: 'jp' },
      committed: { mode: 'standard', region: 'us' },
      resolvedRegion: { code: 'jp', source: 'explicit' },
      preferredRegion: 'jp',
      health: 'healthy',
      rolledBack: true,
      counts: { ok: 0, fail: 1 },
    });
  });

  it('records transaction id, no-op and recovery outcomes', async () => {
    await recordPersistFacts({
      action: 'persist-off',
      outcome: 'noop',
      requested: null,
      committed: null,
      transactionId: 'tx-abc',
      noOp: true,
    }, root);
    await recordPersistFacts({ action: 'persist-recover', outcome: 'recovery_required', counts: { ok: 0, fail: 2 } }, root);
    const entries = await readHistory(10, root);
    expect(entries[0]).toMatchObject({ action: 'persist-recover', outcome: 'recovery_required' });
    expect(entries[1]).toMatchObject({ action: 'persist-off', outcome: 'noop', transactionId: 'tx-abc', noOp: true });
  });

  it('history write failure is observability degradation: no throw, reports false', async () => {
    const blocked = join(root, 'blocked');
    await writeFile(blocked, '占位', 'utf-8');
    const written = await recordPersistFacts({ action: 'persist-on', outcome: 'ok' }, blocked);
    expect(written).toBe(false);
    // 已提交目标不受日志失败影响：后续仍可正常记录
    expect(await recordCheck(1, root)).toBe(true);
  });

  it('serialized records never contain sensitive values', async () => {
    await recordPersistFacts({
      action: 'persist-on',
      outcome: 'ok',
      requested: { mode: 'standard', region: 'us' },
      committed: { mode: 'standard', region: 'us' },
    }, root);
    const content = await (await import('node:fs/promises')).readFile(historyFilePath(root), 'utf-8');
    const sensitive = /(TZ|LANG|LC_ALL|token|cookie|api[_-]?key|password|secret|ssh|BEGIN [A-Z ]*PRIVATE KEY)/i;
    expect(sensitive.test(content)).toBe(false);
    expect(content).toContain('"schemaVersion":2');
  });

  it('returns empty for a missing log and never throws on write failures', async () => {
    expect(await readHistory(10, root)).toEqual([]);
    expect(await appendHistory({ timestamp: 'x', action: 'check' }, root)).toBe(true);
    const entries = await readHistory(10, root);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('check');
    expect(entries[0].schemaVersion).toBe(HISTORY_SCHEMA_VERSION);
  });
});
