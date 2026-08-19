import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionJournalRepository, type TransactionJournal } from '../../state/journal.js';
import { storedValue, type StoredValue } from '../../state/schema.js';
import type { JsonValue } from '../../state/checksum.js';
import type { PersistStepId } from '../steps.js';
import { recoverProtectTransaction, recoverRestoreAuthorities } from './internal/recovery-executor.js';

const ids = ['environment','system_timezone','browser_policies','locale_name','user_languages','user_culture'] as const;
const values = (prefix: string) => Object.fromEntries(ids.map((id) => [id, storedValue(`${prefix}-${id}`)])) as Record<PersistStepId, StoredValue<JsonValue>>;

describe('persist crash recovery executor', () => {
  const fakeRepository = (failures = new Set<string>()) => ({
    transition: async (journal: TransactionJournal, id: string, phase: string) => {
      if (failures.has(`${id}:${phase}`)) throw new Error('injected transition failure');
      return { ...journal, steps: journal.steps.map((step) => step.id === id ? { ...step, phase } : step) } as TransactionJournal;
    },
  }) as TransactionJournalRepository;

  it('reverse-compensates possibly modified protect steps and closes untouched planned steps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-recover-protect-'));
    const repository = new TransactionJournalRepository(root, join(root, 'transaction.json'));
    const originals = values('daily');
    let journal = await repository.plan('protect', ids.map((id) => ({ id, original: originals[id], desired: storedValue(`target-${id}`) })));
    journal = await repository.transition(journal, 'environment', 'applying');
    journal = await repository.transition(journal, 'environment', 'verified');
    journal = await repository.transition(journal, 'system_timezone', 'applying');
    const current = new Map(Object.entries(values('target')) as Array<[PersistStepId, StoredValue<JsonValue>]>);
    const writes: string[] = [];
    const authorities = Object.fromEntries(ids.map((id) => [id, { read: async () => current.get(id)!, write: async (value: StoredValue<JsonValue>) => { writes.push(id); current.set(id, value); } }])) as never;
    const result = await recoverProtectTransaction({ journal, journalRepository: repository, authorities });
    expect(result).toEqual({ kind: 'recovered', failed: [] });
    expect(writes).toEqual(['system_timezone', 'environment']);
    expect((await repository.read())?.steps.every((step) => step.phase === 'compensated')).toBe(true);
  });

  it('treats planned steps as possibly-written when the journal read was degraded (issue #57)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-recover-degraded-'));
    const repository = new TransactionJournalRepository(root, join(root, 'transaction.json'));
    const originals = values('daily');
    // 崩溃现场：current 代（applying/verified）损坏，.prev 回退后全部步骤读作 planned。
    const journal = await repository.plan('protect', ids.map((id) => ({ id, original: originals[id], desired: storedValue(`target-${id}`) })));
    const current = new Map(Object.entries(values('target')) as Array<[PersistStepId, StoredValue<JsonValue>]>);
    const writes: string[] = [];
    const authorities = Object.fromEntries(ids.map((id) => [id, { read: async () => current.get(id)!, write: async (value: StoredValue<JsonValue>) => { writes.push(id); current.set(id, value); } }])) as never;
    const result = await recoverProtectTransaction({ journal, journalRepository: repository, authorities, journalDegraded: true });
    expect(result).toEqual({ kind: 'recovered', failed: [] });
    // 降级解释：planned 视为"可能已写入"，全部回写 original（而非无写关闭）
    expect([...writes].sort()).toEqual([...ids].sort());
    expect((await repository.read())?.steps.every((step) => step.phase === 'compensated')).toBe(true);
    expect([...current.values()]).toEqual([...Object.values(originals)]);
  });

  it('converges every restore authority and rechecks a previously verified value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-recover-restore-'));
    const repository = new TransactionJournalRepository(root, join(root, 'transaction.json'));
    const daily = values('daily');
    let journal = await repository.plan('restore', [...ids.map((id) => ({ id, desired: daily[id] })), { id: 'backup_cleanup' }]);
    journal = await repository.transition(journal, 'environment', 'applying');
    journal = await repository.transition(journal, 'environment', 'verified');
    const current = new Map(Object.entries(values('drift')) as Array<[PersistStepId, StoredValue<JsonValue>]>);
    const authorities = Object.fromEntries(ids.map((id) => [id, { read: async () => current.get(id)!, write: async (value: StoredValue<JsonValue>) => { current.set(id, value); } }])) as never;
    const result = await recoverRestoreAuthorities({ journal, journalRepository: repository, daily, authorities });
    expect(result).toEqual({ kind: 'recovered', failed: [] });
    expect([...current.values()]).toEqual([...Object.values(daily)]);
  });

  it('converges aligned planned and recovery_required steps through real journal legal transitions (C5 回归)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-recover-aligned-'));
    const repository = new TransactionJournalRepository(root, join(root, 'transaction.json'));
    const daily = values('daily');
    let journal = await repository.plan('restore', [...ids.map((id) => ({ id, desired: daily[id] })), { id: 'backup_cleanup' }]);
    journal = await repository.transition(journal, 'environment', 'applying');
    journal = await repository.transition(journal, 'environment', 'verified');
    // 其余五权威与 daily 对齐且阶段为 planned（标准保护崩溃场景）
    const current = new Map(Object.entries(daily) as Array<[PersistStepId, StoredValue<JsonValue>]>);
    const authorities = Object.fromEntries(ids.map((id) => [id, { read: async () => current.get(id)!, write: async (value: StoredValue<JsonValue>) => { current.set(id, value); } }])) as never;
    const result = await recoverRestoreAuthorities({ journal, journalRepository: repository, daily, authorities });
    expect(result).toEqual({ kind: 'recovered', failed: [] });
    // 对齐且阶段为 recovery_required 的重试同样收敛（旧实现可自愈，回归防护）
    const root2 = await mkdtemp(join(tmpdir(), 'cc-fix-recover-aligned2-'));
    const repository2 = new TransactionJournalRepository(root2, join(root2, 'transaction.json'));
    const journal2 = await repository2.plan('restore', [...ids.map((id) => ({ id, desired: daily[id] })), { id: 'backup_cleanup' }]);
    const journal3 = await repository2.transition(journal2, 'system_timezone', 'recovery_required');
    const result2 = await recoverRestoreAuthorities({ journal: journal3, journalRepository: repository2, daily, authorities });
    expect(result2).toEqual({ kind: 'recovered', failed: [] });
  });

  it('rejects recovery with the wrong journal kind', async () => {
    const empty = { transactionId: 'tx', kind: 'restore', steps: [] } as unknown as TransactionJournal;
    await expect(recoverProtectTransaction({ journal: empty, journalRepository: fakeRepository(), authorities: {} as never })).rejects.toThrow(/protect journal/i);
    await expect(recoverRestoreAuthorities({ journal: { ...empty, kind: 'protect' } as TransactionJournal, journalRepository: fakeRepository(), daily: values('daily'), authorities: {} as never })).rejects.toThrow(/restore journal/i);
  });

  it('fails closed across malformed, already-compensated and failed protect recovery steps', async () => {
    const originals = values('daily');
    const journal = {
      transactionId: 'tx-protect-faults', kind: 'protect', steps: [
        { id: 'unknown', phase: 'applying' },
        { id: 'environment', phase: 'compensated', original: originals.environment },
        { id: 'system_timezone', phase: 'planned', original: originals.system_timezone },
        { id: 'browser_policies', phase: 'planned', original: originals.browser_policies },
        { id: 'locale_name', phase: 'applying' },
        { id: 'user_languages', phase: 'compensating', original: originals.user_languages },
        { id: 'user_culture', phase: 'verified', original: originals.user_culture },
      ],
    } as unknown as TransactionJournal;
    const current = new Map(Object.entries(values('target')) as Array<[PersistStepId, StoredValue<JsonValue>]>);
    const authorities = Object.fromEntries(ids.map((id) => [id, {
      read: async () => current.get(id)!,
      write: async (value: StoredValue<JsonValue>) => { if (id !== 'user_culture') current.set(id, value); },
    }])) as never;
    const result = await recoverProtectTransaction({
      journal,
      journalRepository: fakeRepository(new Set(['browser_policies:compensated', 'browser_policies:recovery_required'])),
      authorities,
    });
    expect(result).toEqual({ kind: 'recovery_required', failed: ['user_culture', 'locale_name', 'browser_policies'] });
  });

  it('marks a protect step failed on a denied compensation write and skips re-marking recovery_required', async () => {
    const originals = values('daily');
    const journal = {
      transactionId: 'tx-protect-denied', kind: 'protect', steps: [
        { id: 'environment', phase: 'applying', original: originals.environment },
        { id: 'system_timezone', phase: 'applying', original: originals.system_timezone },
        { id: 'browser_policies', phase: 'recovery_required' },
      ],
    } as unknown as TransactionJournal;
    const current = new Map(Object.entries(values('target')) as Array<[PersistStepId, StoredValue<JsonValue>]>);
    const authorities = Object.fromEntries(ids.map((id) => [id, {
      read: async () => current.get(id)!,
      write: async (value: StoredValue<JsonValue>) => {
        if (id === 'environment') return { unaligned: [{ kind: 'browser_policy_unaligned', slot: 'chrome.webrtc', cause: 'access_denied' }] };
        current.set(id, value);
      },
    }])) as never;
    const result = await recoverProtectTransaction({ journal, journalRepository: fakeRepository(), authorities });
    expect(result.kind).toBe('recovery_required');
    expect(result.failed).toContain('environment');
    expect(result.failed).toContain('browser_policies');
  });

  it('fails the restore step on a denied write and skips redundant applying transitions', async () => {
    const daily = values('daily');
    const journal = {
      transactionId: 'tx-restore-denied', kind: 'restore', steps: [
        { id: 'environment', phase: 'applying' },
        { id: 'system_timezone', phase: 'applying' },
      ],
    } as unknown as TransactionJournal;
    const current = new Map(Object.entries(values('drift')) as Array<[PersistStepId, StoredValue<JsonValue>]>);
    const authorities = Object.fromEntries(ids.map((id) => [id, {
      read: async () => current.get(id)!,
      write: async (value: StoredValue<JsonValue>) => {
        if (id === 'environment') return { unaligned: [{ kind: 'browser_policy_unaligned', slot: 'edge.webrtc', cause: 'access_denied' }] };
        current.set(id, value);
      },
    }])) as never;
    const result = await recoverRestoreAuthorities({ journal, journalRepository: fakeRepository(), daily, authorities });
    expect(result.kind).toBe('recovery_required');
    expect(result.failed).toContain('environment');
  });

  it('fails closed while covering every restore convergence branch', async () => {
    const daily = values('daily');
    const journal = {
      transactionId: 'tx-restore-faults', kind: 'restore', steps: [
        { id: 'system_timezone', phase: 'compensated' },
        { id: 'browser_policies', phase: 'compensating' },
        { id: 'locale_name', phase: 'applying' },
        { id: 'user_languages', phase: 'verified' },
        { id: 'user_culture', phase: 'planned' },
      ],
    } as unknown as TransactionJournal;
    const current = new Map(Object.entries(daily) as Array<[PersistStepId, StoredValue<JsonValue>]>);
    current.set('user_culture', storedValue('drift'));
    const authorities = Object.fromEntries(ids.map((id) => [id, {
      read: async () => current.get(id)!,
      write: async (value: StoredValue<JsonValue>) => { if (id !== 'user_culture') current.set(id, value); },
    }])) as never;
    const result = await recoverRestoreAuthorities({ journal, journalRepository: fakeRepository(), daily, authorities });
    expect(result.kind).toBe('recovery_required');
    expect(result.failed).toEqual(['environment', 'system_timezone', 'browser_policies', 'user_culture']);
  });
});
