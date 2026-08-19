import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recoveryAction, TransactionJournalRepository } from './journal.js';

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
});
