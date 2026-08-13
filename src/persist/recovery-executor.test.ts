import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionJournalRepository } from '../state/journal.js';
import { storedValue, type StoredValue } from '../state/schema.js';
import type { JsonValue } from '../state/checksum.js';
import type { PersistStepId } from './steps.js';
import { recoverProtectTransaction, recoverRestoreAuthorities } from './recovery-executor.js';

const ids = ['environment','system_timezone','browser_policies','locale_name','user_languages','user_culture'] as const;
const values = (prefix: string) => Object.fromEntries(ids.map((id) => [id, storedValue(`${prefix}-${id}`)])) as Record<PersistStepId, StoredValue<JsonValue>>;

describe('persist crash recovery executor', () => {
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
});
