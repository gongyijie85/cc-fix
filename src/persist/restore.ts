import type { JsonValue } from '../state/checksum.js';
import type { StoredValue } from '../state/schema.js';
import type { PersistStepId } from './steps.js';
import type { ExecutableAuthority, ExecutionJournal } from './executor.js';

export type RestoreResult = Readonly<{ verified: readonly PersistStepId[]; failed: readonly PersistStepId[] }>;

/**
 * Converges toward the immutable daily snapshot.  Failure of one field never
 * prevents later fields from being restored or verified.
 */
export async function restoreAll(input: {
  order: readonly PersistStepId[];
  daily: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>;
  authorities: Readonly<Record<PersistStepId, ExecutableAuthority>>;
  journal: ExecutionJournal;
}): Promise<RestoreResult> {
  const verified: PersistStepId[] = [];
  const failed: PersistStepId[] = [];
  for (const id of input.order) {
    try {
      await input.journal.transition(id, 'applying');
      await input.authorities[id].write(input.daily[id]);
      const actual = await input.authorities[id].read();
      if (JSON.stringify(actual) !== JSON.stringify(input.daily[id])) throw new Error('Readback mismatch');
      await input.journal.transition(id, 'verified');
      verified.push(id);
    } catch {
      failed.push(id);
      try { await input.journal.transition(id, 'recovery_required'); } catch {}
    }
  }
  return { verified, failed };
}
