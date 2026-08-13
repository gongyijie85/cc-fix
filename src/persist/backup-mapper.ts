import { randomUUID } from 'node:crypto';
import type { JsonValue } from '../state/checksum.js';
import {
  BACKUP_AUTHORITY_IDS,
  BROWSER_POLICY_SLOTS,
  isBackupSnapshotV4,
  storedMissing,
  storedValue,
  type BackupSnapshotV4,
  type StoredValue,
} from '../state/schema.js';
import type { PersistStepId } from './steps.js';

function requiredProfile(value: StoredValue<JsonValue>, id: string): Record<string, JsonValue> {
  if (value.kind !== 'value' || typeof value.value !== 'object' || value.value === null || Array.isArray(value.value)) {
    throw new Error(`Incomplete daily authority profile: ${id}`);
  }
  return value.value;
}

function scalar<T extends JsonValue>(value: StoredValue<JsonValue>): StoredValue<T> {
  return value.kind === 'missing' ? storedMissing<T>() : storedValue(value.value as T);
}

export function createBackupSnapshotV4(
  values: Readonly<Record<PersistStepId, StoredValue<JsonValue>>>,
  now = new Date().toISOString(),
  snapshotId: string = randomUUID(),
): BackupSnapshotV4 {
  const environment = requiredProfile(values.environment, 'environment');
  const browser = requiredProfile(values.browser_policies, 'browser_policies');
  const snapshot: BackupSnapshotV4 = {
    schemaVersion: 4,
    snapshotId,
    createdAt: now,
    complete: true,
    authoritySet: [...BACKUP_AUTHORITY_IDS],
    authorities: {
      environment: {
        TZ: storedValue(environment.TZ as string | null),
        LANG: storedValue(environment.LANG as string | null),
        LC_ALL: storedValue(environment.LC_ALL as string | null),
      },
      systemTimezone: scalar<string | null>(values.system_timezone),
      browserPolicies: Object.fromEntries(BROWSER_POLICY_SLOTS.map((slot) => {
        const original = browser[slot.id];
        return [slot.id, {
          keyPath: slot.keyPath,
          valueName: slot.valueName,
          value: original === null ? storedMissing() : storedValue({ registryType: 'REG_SZ', value: original as string }),
        }];
      })) as BackupSnapshotV4['authorities']['browserPolicies'],
      localeName: scalar<string | null>(values.locale_name),
      userLanguageList: scalar<string[] | null>(values.user_languages),
      culture: scalar<string | null>(values.user_culture),
    },
  };
  if (!isBackupSnapshotV4(snapshot)) throw new Error('Captured daily authorities cannot form a complete backup');
  return snapshot;
}
