import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storedValue, type StoredValue } from '../state/schema.js';
import type { JsonValue } from '../state/checksum.js';
import { TransactionJournalRepository } from '../state/journal.js';
import type { PersistStepId } from './steps.js';
import { runRestoreTransaction } from './restore-service.js';

const ids = ['environment','system_timezone','browser_policies','locale_name','user_languages','user_culture'] as const;
function values(prefix: string) {
  return Object.fromEntries(ids.map((id) => [id, storedValue(`${prefix}-${id}`)])) as Record<PersistStepId, StoredValue<JsonValue>>;
}

describe('restore transaction service', () => {
  it('publishes daily before verified backup cleanup and clears the transaction last', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-restore-service-'));
    const journalRepository = new TransactionJournalRepository(root, join(root, 'transaction.json'));
    const current = new Map(Object.entries(values('protected')) as Array<[PersistStepId, StoredValue<JsonValue>]>);
    const order: string[] = [];
    const authorities = Object.fromEntries(ids.map((id) => [id, {
      read: async () => current.get(id)!,
      write: async (value: StoredValue<JsonValue>) => { current.set(id, value); order.push(`write:${id}`); },
    }])) as never;
    const result = await runRestoreTransaction({
      protected: true,
      daily: values('daily'),
      authorities,
      journalRepository,
      deleteDailySnapshot: async () => { order.push('delete-backup'); },
      stateTransaction: {
        begin: async () => { order.push('state:begin'); },
        restored: async () => { order.push('state:daily-active'); },
        complete: async () => { order.push('state:complete'); },
        failBeforeRestore: async () => { order.push('state:failed'); },
        failCleanup: async () => { order.push('state:cleanup-failed'); },
      },
    });
    expect(result).toEqual({ kind: 'restored' });
    expect(order.indexOf('state:daily-active')).toBeLessThan(order.indexOf('delete-backup'));
    expect(order.at(-1)).toBe('state:complete');
    expect((await journalRepository.read())?.steps.every((step) => step.phase === 'verified')).toBe(true);
  });

  it('attempts every authority and preserves the backup when any restore fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-restore-failure-'));
    const journalRepository = new TransactionJournalRepository(root, join(root, 'transaction.json'));
    const attempted: string[] = [];
    let deleted = false;
    const authorities = Object.fromEntries(ids.map((id) => [id, {
      read: async () => storedValue(`protected-${id}`),
      write: async () => { attempted.push(id); if (id === 'system_timezone') throw new Error('denied'); },
    }])) as never;
    const result = await runRestoreTransaction({
      protected: true, daily: values('daily'), authorities, journalRepository,
      deleteDailySnapshot: async () => { deleted = true; },
      stateTransaction: { begin: async () => undefined, restored: async () => undefined, complete: async () => undefined, failBeforeRestore: async () => undefined, failCleanup: async () => undefined },
    });
    expect(result).toEqual({ kind: 'recovery_required', failed: [...ids] });
    expect(attempted).toEqual([...ids]);
    expect(deleted).toBe(false);
  });

  it('keeps daily committed-but-active when backup cleanup needs recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-restore-cleanup-'));
    const journalRepository = new TransactionJournalRepository(root, join(root, 'transaction.json'));
    const current = new Map(Object.entries(values('protected')) as Array<[PersistStepId, StoredValue<JsonValue>]>);
    const phases: string[] = [];
    const authorities = Object.fromEntries(ids.map((id) => [id, { read: async () => current.get(id)!, write: async (value: StoredValue<JsonValue>) => { current.set(id, value); } }])) as never;
    const result = await runRestoreTransaction({
      protected: true, daily: values('daily'), authorities, journalRepository,
      deleteDailySnapshot: async () => { throw new Error('busy'); },
      stateTransaction: { begin: async () => undefined, restored: async () => { phases.push('daily'); }, complete: async () => undefined, failBeforeRestore: async () => undefined, failCleanup: async () => { phases.push('recovery'); } },
    });
    expect(result).toEqual({ kind: 'recovery_required', failed: ['backup_cleanup'] });
    expect(phases).toEqual(['daily', 'recovery']);
    expect((await journalRepository.read())?.steps.at(-1)?.phase).toBe('recovery_required');
  });
});
