import { mkdtemp } from 'node:fs/promises';
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
});
