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

function missingIfNull<T extends JsonValue>(value: StoredValue<T | null>): StoredValue<T> {
  return value.kind === 'missing' || value.value === null ? storedMissing<T>() : storedValue(value.value);
}

/** Reconstructs the six executor profiles from the immutable daily snapshot. */
export function backupSnapshotToDailyValues(
  snapshot: BackupSnapshotV4,
): Readonly<Record<PersistStepId, StoredValue<JsonValue>>> {
  if (!isBackupSnapshotV4(snapshot)) throw new Error('Daily backup does not match schema v4');
  const environment = snapshot.authorities.environment;
  const environmentValue = (key: keyof typeof environment): string | null => {
    const value = environment[key];
    return value.kind === 'missing' ? null : value.value;
  };
  const browser = Object.fromEntries(BROWSER_POLICY_SLOTS.map((slot) => {
    const value = snapshot.authorities.browserPolicies[slot.id].value;
    if (value.kind === 'missing') return [slot.id, null];
    if (value.value.registryType !== 'REG_SZ') {
      throw new Error(`Unsupported daily browser policy registry type: ${slot.id}`);
    }
    return [slot.id, value.value.value];
  }));
  return Object.freeze({
    environment: storedValue({
      TZ: environmentValue('TZ'),
      LANG: environmentValue('LANG'),
      LC_ALL: environmentValue('LC_ALL'),
    }),
    system_timezone: missingIfNull(snapshot.authorities.systemTimezone),
    browser_policies: storedValue(browser),
    locale_name: missingIfNull(snapshot.authorities.localeName),
    user_languages: missingIfNull(snapshot.authorities.userLanguageList),
    user_culture: missingIfNull(snapshot.authorities.culture),
  });
}
