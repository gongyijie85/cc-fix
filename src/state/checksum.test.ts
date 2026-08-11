import { describe, expect, it } from 'vitest';
import {
  CheckedEnvelopeError,
  canonicalJson,
  createCheckedEnvelope,
  decodeCheckedEnvelope,
} from './checksum.js';

describe('checked envelope', () => {
  it('produces the same checksum for objects with different key insertion order', () => {
    const first = createCheckedEnvelope('state-v1', { region: 'us', revision: 3 });
    const second = createCheckedEnvelope('state-v1', { revision: 3, region: 'us' });

    expect(first.checksum).toBe(second.checksum);
    expect(canonicalJson(first.payload)).toBe(canonicalJson(second.payload));
  });

  it('round-trips a valid envelope and preserves JSON values', () => {
    const envelope = createCheckedEnvelope('backup-v4', {
      missing: null,
      empty: '',
      list: [],
      unicode: '中文',
    });

    expect(decodeCheckedEnvelope(JSON.stringify(envelope), 'backup-v4')).toEqual(
      envelope,
    );
  });

  it('rejects payload tampering', () => {
    const envelope = createCheckedEnvelope('state-v1', { revision: 1 });
    const tampered = JSON.stringify({
      ...envelope,
      payload: { revision: 2 },
    });

    expect(() => decodeCheckedEnvelope(tampered, 'state-v1')).toThrowError(
      expect.objectContaining<Partial<CheckedEnvelopeError>>({ code: 'CHECKSUM_MISMATCH' }),
    );
  });

  it('binds the schema and envelope version into the checksum', () => {
    const envelope = createCheckedEnvelope('state-v1', { revision: 1 });

    expect(() =>
      decodeCheckedEnvelope(
        JSON.stringify({ ...envelope, schema: 'transaction-v1' }),
        'transaction-v1',
      ),
    ).toThrowError(expect.objectContaining({ code: 'CHECKSUM_MISMATCH' }));
    expect(() =>
      decodeCheckedEnvelope(
        JSON.stringify({ ...envelope, envelopeVersion: 2 }),
        'state-v1',
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ENVELOPE' }));
  });

  it('rejects truncated, malformed, and unexpected envelope shapes', () => {
    expect(() => decodeCheckedEnvelope('{"payload":', 'state-v1')).toThrowError(
      expect.objectContaining({ code: 'INVALID_JSON' }),
    );
    expect(() => decodeCheckedEnvelope('null', 'state-v1')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENVELOPE' }),
    );

    const envelope = createCheckedEnvelope('state-v1', { revision: 1 });
    expect(() =>
      decodeCheckedEnvelope(JSON.stringify({ ...envelope, ignored: true }), 'state-v1'),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ENVELOPE' }));
  });

  it('rejects values that JSON cannot represent deterministically', () => {
    expect(() => canonicalJson({ value: undefined })).toThrowError(
      expect.objectContaining({ code: 'UNCANONICAL_VALUE' }),
    );
    expect(() => canonicalJson({ value: Number.NaN })).toThrowError(
      expect.objectContaining({ code: 'UNCANONICAL_VALUE' }),
    );

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrowError(
      expect.objectContaining({ code: 'UNCANONICAL_VALUE' }),
    );
    expect(() => canonicalJson(new Date(0))).toThrowError(
      expect.objectContaining({ code: 'UNCANONICAL_VALUE' }),
    );
  });

  it('supports null-prototype JSON objects', () => {
    const value = Object.create(null) as Record<string, string>;
    value.region = 'us';

    expect(canonicalJson(value)).toBe('{"region":"us"}');
  });

  it('rejects sparse arrays, explicit undefined entries, and non-index array properties', () => {
    const sparse = new Array(2) as unknown[];
    sparse[1] = 'value';
    expect(() => canonicalJson(sparse)).toThrowError(
      expect.objectContaining({ code: 'UNCANONICAL_VALUE' }),
    );
    expect(() => canonicalJson([undefined])).toThrowError(
      expect.objectContaining({ code: 'UNCANONICAL_VALUE' }),
    );

    const decorated = ['value'] as string[] & { metadata?: string };
    decorated.metadata = 'not-json-array-data';
    expect(() => canonicalJson(decorated)).toThrowError(
      expect.objectContaining({ code: 'UNCANONICAL_VALUE' }),
    );
  });

  it('normalizes negative zero to canonical JSON zero', () => {
    expect(canonicalJson(-0)).toBe('0');
    expect(createCheckedEnvelope('number-v1', -0).checksum).toBe(
      createCheckedEnvelope('number-v1', 0).checksum,
    );
  });

  it('rejects an empty schema, a mismatched schema, and a malformed checksum', () => {
    expect(() => createCheckedEnvelope('', { revision: 1 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENVELOPE' }),
    );

    const envelope = createCheckedEnvelope('state-v1', { revision: 1 });
    expect(() => decodeCheckedEnvelope(JSON.stringify(envelope), 'state-v2')).toThrowError(
      expect.objectContaining({ code: 'SCHEMA_MISMATCH' }),
    );
    expect(() =>
      decodeCheckedEnvelope(
        JSON.stringify({ ...envelope, checksum: envelope.checksum.toUpperCase() }),
        'state-v1',
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ENVELOPE' }));
  });
});
