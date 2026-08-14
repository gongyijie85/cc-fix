import { describe, expect, it } from 'vitest';
import {
  BACKUP_AUTHORITY_IDS,
  BROWSER_POLICY_SLOTS,
  desiredBrowserPolicies,
  cloneImmutable,
  isBackupSnapshotV4,
  isProtectionState,
  isStoredValue,
  storedMissing,
  storedValue,
  storedValueEquals,
  type BackupSnapshotV4,
  type ProtectionState,
  type RegistryValue,
} from './schema.js';

const validState = (): ProtectionState => ({
  schemaVersion: 1,
  revision: 0,
  committedTarget: null,
  preferredRegion: 'us',
  health: 'healthy',
  degradation: [],
  activeTransactionId: null,
  updatedAt: '2026-08-11T12:34:56.789Z',
});

const registryString = (value: string): RegistryValue => ({ registryType: 'REG_SZ', value });

const validBackup = (): BackupSnapshotV4 => ({
  schemaVersion: 4,
  snapshotId: '7f60ed4b-bd54-4f9e-8c4c-c628a94b02a0',
  createdAt: '2026-08-11T12:34:56Z',
  complete: true,
  authoritySet: [...BACKUP_AUTHORITY_IDS],
  authorities: {
    environment: {
      TZ: storedMissing(),
      LANG: storedValue(''),
      LC_ALL: storedValue(null),
    },
    systemTimezone: storedValue('Tokyo Standard Time'),
    browserPolicies: Object.fromEntries(
      BROWSER_POLICY_SLOTS.map((slot) => [
        slot.id,
        {
          keyPath: slot.keyPath,
          valueName: slot.valueName,
          value: storedValue(registryString('日本語,ja')),
        },
      ]),
    ) as BackupSnapshotV4['authorities']['browserPolicies'],
    localeName: storedValue('ja-JP'),
    userLanguageList: storedValue([]),
    culture: storedValue('ja-JP'),
  },
});

describe('StoredValue exact semantics', () => {
  it.each([
    ['missing', storedMissing()],
    ['null', storedValue(null)],
    ['empty string', storedValue('')],
    ['empty list', storedValue([])],
    ['Unicode', storedValue('日本語-🌏')],
  ])('round-trips %s without conflating it with another variant', (_name, input) => {
    const decoded = JSON.parse(JSON.stringify(input)) as unknown;
    expect(isStoredValue(decoded, () => true)).toBe(true);
    expect(storedValueEquals(input, decoded as typeof input)).toBe(true);
  });

  it('does not permit undefined as a stored value', () => {
    expect(isStoredValue({ kind: 'value', value: undefined }, () => true)).toBe(false);
  });

  it('returns an immutable clone so caller mutation cannot cross the boundary', () => {
    const source = { nested: { values: ['a'] } };
    const immutable = cloneImmutable(source);
    source.nested.values.push('changed');
    expect(immutable).toEqual({ nested: { values: ['a'] } });
    expect(Object.isFrozen(immutable.nested.values)).toBe(true);
  });

  it('StoredValue detaches and freezes its input value', () => {
    const source = { values: ['daily'] };
    const stored = storedValue(source);
    source.values.push('changed');
    expect(stored).toEqual({ kind: 'value', value: { values: ['daily'] } });
    expect(Object.isFrozen(stored)).toBe(true);
    expect(stored.kind === 'value' && Object.isFrozen(stored.value.values)).toBe(true);
  });

  it('rejects accessors without invoking them', () => {
    let getterCalls = 0;
    const unsafe = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'value';
      },
    });
    expect(() => cloneImmutable(unsafe)).toThrow('dense plain JSON');
    expect(getterCalls).toBe(0);
  });
});

describe('ProtectionState schema v1', () => {
  it('accepts the exact valid state shape', () => {
    expect(isProtectionState(validState())).toBe(true);
  });

  it.each([
    ['unknown schema', { schemaVersion: 2 }],
    ['unsafe revision', { revision: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative revision', { revision: -1 }],
    ['invalid target mode', { committedTarget: { mode: 'daily', region: 'us' } }],
    ['invalid target region', { committedTarget: { mode: 'standard', region: 'cn' } }],
    ['invalid preferred region', { preferredRegion: 'cn' }],
    ['invalid health', { health: 'unknown' }],
    ['invalid time rollover', { updatedAt: '2026-02-30T12:00:00Z' }],
    ['non-RFC3339 time', { updatedAt: '2026-08-11 12:00:00' }],
    ['extra key', { extra: true }],
  ])('rejects %s', (_name, change) => {
    expect(isProtectionState({ ...validState(), ...change })).toBe(false);
  });

  it('rejects a missing required field and duplicate degradation slots', () => {
    const missing = validState() as unknown as Record<string, unknown>;
    delete missing.preferredRegion;
    expect(isProtectionState(missing)).toBe(false);
    expect(
      isProtectionState({
        ...validState(),
        health: 'degraded',
        degradation: [
          { kind: 'browser_policy_unaligned', slot: 'edge.webrtc', cause: 'access_denied' },
          { kind: 'browser_policy_unaligned', slot: 'edge.webrtc', cause: 'access_denied' },
        ],
      }),
    ).toBe(false);
  });

  it('requires typed browser-policy reasons only for degraded health', () => {
    expect(
      isProtectionState({
        ...validState(),
        health: 'degraded',
        degradation: [
          { kind: 'browser_policy_unaligned', slot: 'edge.webrtc', cause: 'access_denied' },
        ],
      }),
    ).toBe(true);
    expect(
      isProtectionState({
        ...validState(),
        health: 'degraded',
        degradation: [{ kind: 'browser_policy_unaligned', slot: 'edge.webrtc', cause: 'secret' }],
      }),
    ).toBe(false);
    expect(isProtectionState({ ...validState(), health: 'degraded', degradation: [] })).toBe(false);
    expect(
      isProtectionState({
        ...validState(),
        degradation: [
          { kind: 'browser_policy_unaligned', slot: 'edge.webrtc', cause: 'access_denied' },
        ],
      }),
    ).toBe(false);
  });

  it('rejects sparse or decorated degradation arrays and invokes no accessor', () => {
    const sparse = new Array(1);
    expect(isProtectionState({ ...validState(), degradation: sparse })).toBe(false);
    const decorated = [] as unknown[] & { extra?: string };
    decorated.extra = 'not-json-array';
    expect(isProtectionState({ ...validState(), degradation: decorated })).toBe(false);
    let getterCalls = 0;
    const state = validState() as unknown as Record<string, unknown>;
    Object.defineProperty(state, 'preferredRegion', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'us';
      },
    });
    expect(isProtectionState(state)).toBe(false);
    expect(getterCalls).toBe(0);
  });
});

describe('BackupSnapshot schema v4', () => {
  it('declares the six managed browser policy slots exactly once (ADR-0011 catalogue)', () => {
    const ids = BROWSER_POLICY_SLOTS.map((slot) => slot.id);
    expect(new Set(ids).size).toBe(6);
    expect(ids).toEqual([
      'chrome.accept_language',
      'chrome.webrtc',
      'chrome.application_locale',
      'edge.accept_language',
      'edge.webrtc',
      'edge.application_locale',
    ]);
    const paths = new Set(BROWSER_POLICY_SLOTS.map((slot) => `${slot.keyPath}\\u0000${slot.valueName}`));
    expect(paths.size).toBe(6);
  });

  it('derives desired policies in the authority vocabulary', () => {
    const desired = desiredBrowserPolicies('en_US.UTF-8');
    expect(Object.keys(desired).sort()).toEqual(BROWSER_POLICY_SLOTS.map((slot) => slot.id).sort());
    expect(desired['chrome.accept_language']).toBe('en-US,en');
    expect(desired['edge.accept_language']).toBe('en-US,en');
    expect(desired['chrome.application_locale']).toBe('en-US');
    expect(desired['edge.webrtc']).toBe('disable_non_proxied_udp');
  });

  it('round-trips all supported registry types exactly', () => {
    const values: RegistryValue[] = [
      { registryType: 'REG_NONE', valueBase64: 'AA==' },
      { registryType: 'REG_SZ', value: '日本語' },
      { registryType: 'REG_EXPAND_SZ', value: '%USERPROFILE%' },
      { registryType: 'REG_BINARY', valueBase64: 'AP8=' },
      { registryType: 'REG_DWORD', value: 4_294_967_295 },
      { registryType: 'REG_DWORD_BIG_ENDIAN', value: 1 },
      { registryType: 'REG_LINK', value: '\\Registry\\User' },
      { registryType: 'REG_MULTI_SZ', value: [] },
      { registryType: 'REG_RESOURCE_LIST', valueBase64: '' },
      { registryType: 'REG_FULL_RESOURCE_DESCRIPTOR', valueBase64: '' },
      { registryType: 'REG_RESOURCE_REQUIREMENTS_LIST', valueBase64: '' },
      { registryType: 'REG_QWORD', value: '18446744073709551615' },
    ];

    for (const registryValue of values) {
      const backup = validBackup();
      backup.authorities.browserPolicies['chrome.accept_language'].value =
        storedValue(registryValue);
      expect(isBackupSnapshotV4(JSON.parse(JSON.stringify(backup)))).toBe(true);
    }
  });

  it('accepts only the complete exact authority set', () => {
    expect(isBackupSnapshotV4(validBackup())).toBe(true);
    const missing = validBackup() as unknown as Record<string, unknown>;
    delete (missing.authorities as Record<string, unknown>).culture;
    expect(isBackupSnapshotV4(missing)).toBe(false);

    const duplicate = validBackup();
    duplicate.authoritySet = [...duplicate.authoritySet, 'culture'];
    expect(isBackupSnapshotV4(duplicate)).toBe(false);

    const unknown = validBackup() as unknown as Record<string, unknown>;
    (unknown.authorities as Record<string, unknown>).network = storedValue('forbidden');
    expect(isBackupSnapshotV4(unknown)).toBe(false);
  });

  it('rejects altered browser slot identity and malformed values', () => {
    const changedPath = validBackup();
    changedPath.authorities.browserPolicies['edge.webrtc'].keyPath = 'HKCU\\Unexpected';
    expect(isBackupSnapshotV4(changedPath)).toBe(false);

    const unknownSlot = validBackup() as unknown as Record<string, unknown>;
    const policies = (unknownSlot.authorities as Record<string, unknown>)
      .browserPolicies as Record<string, unknown>;
    policies['firefox.webrtc'] = policies['edge.webrtc'];
    expect(isBackupSnapshotV4(unknownSlot)).toBe(false);

    const invalidRegistry = validBackup();
    invalidRegistry.authorities.browserPolicies['chrome.webrtc'].value = storedValue({
      registryType: 'REG_DWORD',
      value: -1,
    });
    expect(isBackupSnapshotV4(invalidRegistry)).toBe(false);
  });

  it('rejects sparse authority, language and REG_MULTI_SZ arrays', () => {
    const sparseAuthorities = validBackup();
    sparseAuthorities.authoritySet = new Array(BACKUP_AUTHORITY_IDS.length) as never;
    expect(isBackupSnapshotV4(sparseAuthorities)).toBe(false);

    const sparseLanguages = validBackup() as unknown as Record<string, unknown>;
    const languageAuthorities = sparseLanguages.authorities as Record<string, unknown>;
    languageAuthorities.userLanguageList = { kind: 'value', value: new Array(1) };
    expect(isBackupSnapshotV4(sparseLanguages)).toBe(false);

    const sparseRegistry = validBackup() as unknown as Record<string, unknown>;
    const registryAuthorities = sparseRegistry.authorities as Record<string, unknown>;
    const policies = registryAuthorities.browserPolicies as Record<string, Record<string, unknown>>;
    policies['chrome.accept_language'].value = {
      kind: 'value',
      value: { registryType: 'REG_MULTI_SZ', value: new Array(1) },
    };
    expect(isBackupSnapshotV4(sparseRegistry)).toBe(false);
  });

  it('rejects non-canonical base64 encodings', () => {
    const backup = validBackup() as unknown as Record<string, unknown>;
    const authorities = backup.authorities as Record<string, unknown>;
    const policies = authorities.browserPolicies as Record<string, Record<string, unknown>>;
    policies['chrome.webrtc'].value = {
      kind: 'value',
      value: { registryType: 'REG_BINARY', valueBase64: 'AB==' },
    };
    expect(isBackupSnapshotV4(backup)).toBe(false);
  });
});
