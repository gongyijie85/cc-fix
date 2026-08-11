import { createHash, timingSafeEqual } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface CheckedEnvelope<T extends JsonValue = JsonValue> {
  envelopeVersion: 1;
  schema: string;
  algorithm: 'sha256';
  payload: T;
  checksum: string;
}

export type CheckedEnvelopeErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_ENVELOPE'
  | 'SCHEMA_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'UNCANONICAL_VALUE';

export class CheckedEnvelopeError extends Error {
  readonly code: CheckedEnvelopeErrorCode;

  constructor(code: CheckedEnvelopeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CheckedEnvelopeError';
    this.code = code;
  }
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CheckedEnvelopeError('UNCANONICAL_VALUE', 'Non-finite numbers are not JSON values');
    }
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new CheckedEnvelopeError(
      'UNCANONICAL_VALUE',
      `Unsupported JSON value type: ${typeof value}`,
    );
  }
  if (ancestors.has(value)) {
    throw new CheckedEnvelopeError('UNCANONICAL_VALUE', 'Cyclic values are not JSON values');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      const hasOnlyArrayIndices = ownKeys.every((key) => {
        if (key === 'length') return true;
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key)) return false;
        const index = Number(key);
        return Number.isSafeInteger(index) && index >= 0 && index < value.length;
      });
      if (!hasOnlyArrayIndices) {
        throw new CheckedEnvelopeError(
          'UNCANONICAL_VALUE',
          'JSON arrays cannot carry non-index own properties',
        );
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new CheckedEnvelopeError('UNCANONICAL_VALUE', 'Sparse JSON arrays are not supported');
        }
        items.push(canonicalize(value[index], ancestors));
      }
      return `[${items.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CheckedEnvelopeError('UNCANONICAL_VALUE', 'Only plain JSON objects are supported');
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

function checksumInput<T extends JsonValue>(
  schema: string,
  payload: T,
): Omit<CheckedEnvelope<T>, 'checksum'> {
  return {
    envelopeVersion: 1,
    schema,
    algorithm: 'sha256',
    payload,
  };
}

function computeChecksum<T extends JsonValue>(schema: string, payload: T): string {
  return createHash('sha256').update(canonicalJson(checksumInput(schema, payload))).digest('hex');
}

export function createCheckedEnvelope<T extends JsonValue>(
  schema: string,
  payload: T,
): CheckedEnvelope<T> {
  if (schema.length === 0) {
    throw new CheckedEnvelopeError('INVALID_ENVELOPE', 'Envelope schema must not be empty');
  }
  return {
    ...checksumInput(schema, payload),
    checksum: computeChecksum(schema, payload),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeCheckedEnvelope<T extends JsonValue = JsonValue>(
  serialized: string,
  expectedSchema: string,
): CheckedEnvelope<T> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new CheckedEnvelopeError('INVALID_JSON', 'Checked file is not valid JSON', {
      cause: error,
    });
  }

  const expectedKeys = ['algorithm', 'checksum', 'envelopeVersion', 'payload', 'schema'];
  if (
    !isRecord(decoded) ||
    JSON.stringify(Object.keys(decoded).sort()) !== JSON.stringify(expectedKeys) ||
    decoded.envelopeVersion !== 1 ||
    decoded.algorithm !== 'sha256' ||
    typeof decoded.schema !== 'string' ||
    typeof decoded.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(decoded.checksum)
  ) {
    throw new CheckedEnvelopeError('INVALID_ENVELOPE', 'Checked file envelope has an invalid shape');
  }
  if (decoded.schema !== expectedSchema) {
    throw new CheckedEnvelopeError(
      'SCHEMA_MISMATCH',
      `Expected schema ${expectedSchema}, received ${decoded.schema}`,
    );
  }

  let actualChecksum: string;
  try {
    actualChecksum = computeChecksum(decoded.schema, decoded.payload as JsonValue);
  } catch (error) {
    if (error instanceof CheckedEnvelopeError) {
      throw error;
    }
    throw new CheckedEnvelopeError('INVALID_ENVELOPE', 'Envelope payload is not canonical JSON', {
      cause: error,
    });
  }
  const expectedBytes = Buffer.from(decoded.checksum, 'hex');
  const actualBytes = Buffer.from(actualChecksum, 'hex');
  if (!timingSafeEqual(expectedBytes, actualBytes)) {
    throw new CheckedEnvelopeError('CHECKSUM_MISMATCH', 'Checked file checksum does not match');
  }

  return decoded as unknown as CheckedEnvelope<T>;
}

export function serializeCheckedEnvelope<T extends JsonValue>(
  envelope: CheckedEnvelope<T>,
): string {
  return `${canonicalJson(envelope)}\n`;
}
