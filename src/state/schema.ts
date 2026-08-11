import { canonicalJson, type JsonValue } from './checksum.js';
import {
  PROTECTION_HEALTH_VALUES,
  type ProtectionHealth,
  type ProtectionTarget,
} from '../domain/protection.js';
import { isRegionCode, type RegionCode } from '../domain/region.js';

export const BROWSER_POLICY_SLOTS = [
  {
    id: 'chrome.accept_language',
    browser: 'chrome',
    keyPath: 'HKCU\\Software\\Policies\\Google\\Chrome',
    valueName: 'AcceptLanguage',
  },
  {
    id: 'chrome.webrtc',
    browser: 'chrome',
    keyPath: 'HKCU\\Software\\Policies\\Google\\Chrome',
    valueName: 'DefaultWebRtcIPHandlingPolicy',
  },
  {
    id: 'chrome.application_locale',
    browser: 'chrome',
    keyPath: 'HKCU\\Software\\Policies\\Google\\Chrome',
    valueName: 'ApplicationLocaleValue',
  },
  {
    id: 'edge.accept_language',
    browser: 'edge',
    keyPath: 'HKCU\\Software\\Policies\\Microsoft\\Edge',
    valueName: 'AcceptLanguage',
  },
  {
    id: 'edge.webrtc',
    browser: 'edge',
    keyPath: 'HKCU\\Software\\Policies\\Microsoft\\Edge',
    valueName: 'DefaultWebRtcIPHandlingPolicy',
  },
  {
    id: 'edge.application_locale',
    browser: 'edge',
    keyPath: 'HKCU\\Software\\Policies\\Microsoft\\Edge',
    valueName: 'ApplicationLocaleValue',
  },
] as const;

export type BrowserPolicySlotId = (typeof BROWSER_POLICY_SLOTS)[number]['id'];

export type DegradationReason = {
  kind: 'browser_policy_unaligned';
  slot: BrowserPolicySlotId;
  cause: 'managed' | 'access_denied';
};

export type ProtectionState = {
  schemaVersion: 1;
  revision: number;
  committedTarget: ProtectionTarget | null;
  preferredRegion: RegionCode;
  health: ProtectionHealth;
  degradation: DegradationReason[];
  activeTransactionId: string | null;
  updatedAt: string;
};

export type StoredValue<T> = { kind: 'missing' } | { kind: 'value'; value: T };

export function storedMissing<T = never>(): StoredValue<T> {
  return { kind: 'missing' };
}

export function storedValue<T>(value: T extends undefined ? never : T): StoredValue<T> {
  if (value === undefined) throw new TypeError('StoredValue cannot contain undefined');
  return { kind: 'value', value };
}

export function isStoredValue<T>(
  input: unknown,
  validateValue: (value: unknown) => value is T,
): input is StoredValue<T>;
export function isStoredValue(
  input: unknown,
  validateValue: (value: unknown) => boolean,
): input is StoredValue<unknown>;
export function isStoredValue(
  input: unknown,
  validateValue: (value: unknown) => boolean,
): input is StoredValue<unknown> {
  if (!isRecord(input)) return false;
  if (input.kind === 'missing') return hasExactKeys(input, ['kind']);
  return (
    input.kind === 'value' &&
    hasExactKeys(input, ['kind', 'value']) &&
    input.value !== undefined &&
    validateValue(input.value)
  );
}

export function storedValueEquals<T>(left: StoredValue<T>, right: StoredValue<T>): boolean {
  if (left.kind === 'missing' || right.kind === 'missing') return left.kind === right.kind;
  return canonicalJson(left.value as JsonValue) === canonicalJson(right.value as JsonValue);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function cloneImmutable<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isProtectionTarget(value: unknown): value is ProtectionTarget {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['mode', 'region']) &&
    (value.mode === 'standard' || value.mode === 'deep') &&
    isRegionCode(value.region)
  );
}

function isStrictRfc3339(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (match === null) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) return false;
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= maxDay && Number.isFinite(Date.parse(value));
}

function isDegradationReason(value: unknown): value is DegradationReason {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['kind', 'slot', 'cause']) &&
    value.kind === 'browser_policy_unaligned' &&
    BROWSER_POLICY_SLOTS.some((slot) => slot.id === value.slot) &&
    (value.cause === 'managed' || value.cause === 'access_denied')
  );
}

export function isProtectionState(value: unknown): value is ProtectionState {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'revision',
    'committedTarget',
    'preferredRegion',
    'health',
    'degradation',
    'activeTransactionId',
    'updatedAt',
  ])) return false;
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !(value.committedTarget === null || isProtectionTarget(value.committedTarget)) ||
    !isRegionCode(value.preferredRegion) ||
    !PROTECTION_HEALTH_VALUES.includes(value.health as ProtectionHealth) ||
    !Array.isArray(value.degradation) ||
    !value.degradation.every(isDegradationReason) ||
    !(value.activeTransactionId === null ||
      (typeof value.activeTransactionId === 'string' &&
        value.activeTransactionId.length > 0 &&
        value.activeTransactionId.length <= 128)) ||
    !isStrictRfc3339(value.updatedAt)
  ) return false;
  const uniqueReasons = new Set(value.degradation.map((reason) => reason.slot));
  if (uniqueReasons.size !== value.degradation.length) return false;
  return value.health === 'degraded'
    ? value.degradation.length > 0
    : value.degradation.length === 0;
}

export type RegistryValue =
  | { registryType: 'REG_NONE' | 'REG_BINARY' | 'REG_RESOURCE_LIST' | 'REG_FULL_RESOURCE_DESCRIPTOR' | 'REG_RESOURCE_REQUIREMENTS_LIST'; valueBase64: string }
  | { registryType: 'REG_SZ' | 'REG_EXPAND_SZ' | 'REG_LINK'; value: string }
  | { registryType: 'REG_DWORD' | 'REG_DWORD_BIG_ENDIAN'; value: number }
  | { registryType: 'REG_MULTI_SZ'; value: string[] }
  | { registryType: 'REG_QWORD'; value: string };

export const BACKUP_AUTHORITY_IDS = [
  'environment.TZ',
  'environment.LANG',
  'environment.LC_ALL',
  'systemTimezone',
  'browser.chrome.accept_language',
  'browser.chrome.webrtc',
  'browser.chrome.application_locale',
  'browser.edge.accept_language',
  'browser.edge.webrtc',
  'browser.edge.application_locale',
  'localeName',
  'userLanguageList',
  'culture',
] as const;

export type BackupAuthorityId = (typeof BACKUP_AUTHORITY_IDS)[number];

export type BrowserPolicyBackup = {
  keyPath: string;
  valueName: string;
  value: StoredValue<RegistryValue>;
};

export type BackupSnapshotV4 = {
  schemaVersion: 4;
  snapshotId: string;
  createdAt: string;
  complete: true;
  authoritySet: BackupAuthorityId[];
  authorities: {
    environment: {
      TZ: StoredValue<string | null>;
      LANG: StoredValue<string | null>;
      LC_ALL: StoredValue<string | null>;
    };
    systemTimezone: StoredValue<string | null>;
    browserPolicies: Record<BrowserPolicySlotId, BrowserPolicyBackup>;
    localeName: StoredValue<string | null>;
    userLanguageList: StoredValue<string[] | null>;
    culture: StoredValue<string | null>;
  };
};

export type RestoreVerificationReceipt = {
  schemaVersion: 1;
  snapshotId: string;
  restoreReceiptId: string;
  verifiedAt: string;
  completedAuthorities: BackupAuthorityId[];
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isStringArrayOrNull(value: unknown): value is string[] | null {
  return value === null || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function isBase64(value: unknown): value is string {
  return typeof value === 'string' &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function isRegistryValue(value: unknown): value is RegistryValue {
  if (!isRecord(value) || typeof value.registryType !== 'string') return false;
  if ([
    'REG_NONE',
    'REG_BINARY',
    'REG_RESOURCE_LIST',
    'REG_FULL_RESOURCE_DESCRIPTOR',
    'REG_RESOURCE_REQUIREMENTS_LIST',
  ].includes(value.registryType)) {
    return hasExactKeys(value, ['registryType', 'valueBase64']) && isBase64(value.valueBase64);
  }
  if (['REG_SZ', 'REG_EXPAND_SZ', 'REG_LINK'].includes(value.registryType)) {
    return hasExactKeys(value, ['registryType', 'value']) && typeof value.value === 'string';
  }
  if (value.registryType === 'REG_DWORD' || value.registryType === 'REG_DWORD_BIG_ENDIAN') {
    return hasExactKeys(value, ['registryType', 'value']) &&
      Number.isInteger(value.value) &&
      (value.value as number) >= 0 &&
      (value.value as number) <= 0xffff_ffff;
  }
  if (value.registryType === 'REG_MULTI_SZ') {
    return hasExactKeys(value, ['registryType', 'value']) &&
      Array.isArray(value.value) &&
      value.value.every((item) => typeof item === 'string');
  }
  return value.registryType === 'REG_QWORD' &&
    hasExactKeys(value, ['registryType', 'value']) &&
    typeof value.value === 'string' &&
    /^(0|[1-9]\d*)$/u.test(value.value) &&
    value.value.length <= 20 &&
    BigInt(value.value) <= 18_446_744_073_709_551_615n;
}

function isExactAuthoritySet(value: unknown): value is BackupAuthorityId[] {
  return Array.isArray(value) &&
    value.length === BACKUP_AUTHORITY_IDS.length &&
    value.every((item, index) => item === BACKUP_AUTHORITY_IDS[index]);
}

function isCompleteAuthoritySet(value: unknown): value is BackupAuthorityId[] {
  return Array.isArray(value) &&
    value.length === BACKUP_AUTHORITY_IDS.length &&
    value.every((item) => BACKUP_AUTHORITY_IDS.includes(item as BackupAuthorityId)) &&
    new Set(value).size === BACKUP_AUTHORITY_IDS.length;
}

function isBrowserPolicyBackups(value: unknown): value is Record<BrowserPolicySlotId, BrowserPolicyBackup> {
  if (!isRecord(value) || !hasExactKeys(value, BROWSER_POLICY_SLOTS.map((slot) => slot.id))) return false;
  return BROWSER_POLICY_SLOTS.every((slot) => {
    const candidate = value[slot.id];
    return isRecord(candidate) &&
      hasExactKeys(candidate, ['keyPath', 'valueName', 'value']) &&
      candidate.keyPath === slot.keyPath &&
      candidate.valueName === slot.valueName &&
      isStoredValue(candidate.value, isRegistryValue);
  });
}

export function isBackupSnapshotV4(value: unknown): value is BackupSnapshotV4 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'snapshotId', 'createdAt', 'complete', 'authoritySet', 'authorities',
  ])) return false;
  if (
    value.schemaVersion !== 4 ||
    !isUuid(value.snapshotId) ||
    !isStrictRfc3339(value.createdAt) ||
    value.complete !== true ||
    !isExactAuthoritySet(value.authoritySet) ||
    !isRecord(value.authorities) ||
    !hasExactKeys(value.authorities, [
      'environment', 'systemTimezone', 'browserPolicies', 'localeName', 'userLanguageList', 'culture',
    ])
  ) return false;
  const authorities = value.authorities;
  return isRecord(authorities.environment) &&
    hasExactKeys(authorities.environment, ['TZ', 'LANG', 'LC_ALL']) &&
    isStoredValue(authorities.environment.TZ, isStringOrNull) &&
    isStoredValue(authorities.environment.LANG, isStringOrNull) &&
    isStoredValue(authorities.environment.LC_ALL, isStringOrNull) &&
    isStoredValue(authorities.systemTimezone, isStringOrNull) &&
    isBrowserPolicyBackups(authorities.browserPolicies) &&
    isStoredValue(authorities.localeName, isStringOrNull) &&
    isStoredValue(authorities.userLanguageList, isStringArrayOrNull) &&
    isStoredValue(authorities.culture, isStringOrNull);
}

export function isRestoreVerificationReceipt(value: unknown): value is RestoreVerificationReceipt {
  return isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion', 'snapshotId', 'restoreReceiptId', 'verifiedAt', 'completedAuthorities',
    ]) &&
    value.schemaVersion === 1 &&
    isUuid(value.snapshotId) &&
    isUuid(value.restoreReceiptId) &&
    isStrictRfc3339(value.verifiedAt) &&
    isCompleteAuthoritySet(value.completedAuthorities);
}
