import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCheckedEnvelope, serializeCheckedEnvelope } from './checksum.js';
import { recoveryAction, TRANSACTION_JOURNAL_SCHEMA, TransactionJournalRepository } from './journal.js';

describe('transaction journal', () => {
  it('durably records a plan before any step transition and preserves order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-journal-'));
    const repo = new TransactionJournalRepository(root, join(root, 'transaction-journal.json'));
    const planned = await repo.plan('protect', [{ id: 'env', original: { TZ: 'old' }, desired: { TZ: 'new' } }, 'browser']);
    expect((await repo.read())?.steps).toEqual([{ id: 'env', phase: 'planned', original: { TZ: 'old' }, desired: { TZ: 'new' } }, { id: 'browser', phase: 'planned' }]);
    const applying = await repo.transition(planned, 'env', 'applying');
    const verified = await repo.transition(applying, 'env', 'verified');
    expect((await repo.read())).toEqual(verified);
  });

  it('rejects duplicate plans and transitions outside the durable plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-journal-'));
    const repo = new TransactionJournalRepository(root, join(root, 'transaction-journal.json'));
    await expect(repo.plan('restore', ['x', 'x'])).rejects.toThrow('unique');
    const planned = await repo.plan('restore', ['x']);
    await expect(repo.transition(planned, 'missing', 'applying')).rejects.toThrow('not planned');
    await expect(repo.transition(planned, 'x', 'verified')).rejects.toThrow('Illegal');
  });

  it('chooses one deterministic recovery action from every unfinished plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-journal-'));
    const repo = new TransactionJournalRepository(root, join(root, 'transaction-journal.json'));
    const protect = await repo.plan('protect', ['x']);
    expect(recoveryAction(protect)).toBe('reverse_compensation');
    await expect(repo.plan('restore', ['y'])).rejects.toThrow('unfinished');
    const restore = { ...protect, kind: 'restore' as const };
    expect(recoveryAction(restore)).toBe('forward_restore');
  });

  it('reports degraded reads when the corrupt current generation falls back to .prev (issue #57)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-journal-degraded-'));
    const journalPath = join(root, 'transaction-journal.json');
    const repo = new TransactionJournalRepository(root, journalPath);
    // 正常读取不降级
    const planned = await repo.plan('protect', [{ id: 'env', original: { TZ: 'old' } }]);
    await expect(repo.readWithDegradation()).resolves.toMatchObject({ degraded: false, journal: { steps: [{ id: 'env', phase: 'planned' }] } });
    // 第二次写入把 planned 滚入 .prev，current 推进为 applying
    await repo.transition(planned, 'env', 'applying');
    // current 代损坏 → 回退 .prev（phase 滞后于崩溃现场）
    await writeFile(journalPath, '{ corrupt', 'utf8');
    const degraded = await repo.readWithDegradation();
    expect(degraded.degraded).toBe(true);
    expect(degraded.journal?.steps[0]).toMatchObject({ id: 'env', phase: 'planned' });
  });

  it('keeps the phase table small and the values in a separate snapshot file (issue #59)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-journal-split-'));
    const journalPath = join(root, 'transaction-journal.json');
    const valuesPath = `${journalPath}.values`;
    const repo = new TransactionJournalRepository(root, journalPath);
    const planned = await repo.plan('protect', [{ id: 'env', original: { TZ: 'old' }, desired: { TZ: 'new' } }]);
    // phase 表剥去快照值（写入为 checksum envelope，payload 内为 phase 表）
    const phaseDoc = JSON.parse(await readFile(journalPath, 'utf8'));
    expect(phaseDoc.payload.steps).toEqual([{ id: 'env', phase: 'planned' }]);
    expect('original' in phaseDoc.payload.steps[0]).toBe(false);
    // values 快照单独落盘
    const valuesDoc = JSON.parse(await readFile(valuesPath, 'utf8'));
    expect(valuesDoc.payload.values.env.original).toEqual({ TZ: 'old' });
    expect(valuesDoc.payload.values.env.desired).toEqual({ TZ: 'new' });
    // 读回合并完整值
    const merged = await repo.read();
    expect(merged?.steps[0]).toMatchObject({ id: 'env', phase: 'planned', original: { TZ: 'old' }, desired: { TZ: 'new' } });
    // transition 后读回仍合并完整值
    const transitioned = await repo.transition(planned, 'env', 'applying');
    expect((await repo.read())?.steps[0]).toMatchObject({ id: 'env', phase: 'applying', original: { TZ: 'old' } });
    expect(transitioned.steps[0]).toMatchObject({ phase: 'applying', original: { TZ: 'old' } });
  });

  it('reads legacy single-file journals that embed values inline (issue #59 兼容)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-journal-legacy-'));
    const journalPath = join(root, 'transaction-journal.json');
    const repo = new TransactionJournalRepository(root, journalPath);
    // 构造旧格式：值内嵌于 steps 的单文件（无 values 快照），带合法 checksum envelope
    const legacy = { transactionId: 'legacy-tx', kind: 'protect', steps: [{ id: 'env', phase: 'planned', original: { TZ: 'old' }, desired: { TZ: 'new' } }] };
    await writeFile(
      journalPath,
      serializeCheckedEnvelope(createCheckedEnvelope(TRANSACTION_JOURNAL_SCHEMA, legacy as never)),
      'utf8',
    );
    // values 文件不存在也不报错：旧格式直接返回内嵌值
    const readBack = await repo.read();
    expect(readBack).toBeDefined();
    expect(readBack?.steps[0]).toMatchObject({ id: 'env', phase: 'planned', original: { TZ: 'old' }, desired: { TZ: 'new' } });
  });
});
