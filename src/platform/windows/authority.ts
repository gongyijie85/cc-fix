import { storedMissing, storedValue, storedValueEquals, type StoredValue } from '../../state/schema.js';
import type { JsonValue } from '../../state/checksum.js';

export class AuthorityError extends Error {
  constructor(readonly code: 'INVALID_VALUE' | 'READBACK_MISMATCH' | 'WRITE_FAILED', message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** A single managed user/system setting. Network configuration is deliberately absent. */
export interface WindowsAuthority<T extends JsonValue> {
  readonly id: string;
  read(): Promise<StoredValue<T>>;
  write(value: StoredValue<T>): Promise<void>;
}

export type AuthorityIo<T extends JsonValue> = Readonly<{
  readRaw(): Promise<T | null>;
  writeRaw(value: T): Promise<void>;
  removeRaw(): Promise<void>;
  validate(value: unknown): value is T;
}>;

/**
 * Reads and writes a StoredValue atomically at the authority boundary, then
 * always reads it back. Unknown I/O errors are fatal. Degradation classification
 * lives in the registry adapter (native-backend), not here.
 */
export function createWindowsAuthority<T extends JsonValue>(id: string, io: AuthorityIo<T>): WindowsAuthority<T> {
  async function read(): Promise<StoredValue<T>> {
    const raw = await io.readRaw();
    if (raw === null) return storedMissing<T>();
    if (!io.validate(raw)) throw new AuthorityError('INVALID_VALUE', `Invalid value read from ${id}`);
    return storedValue(raw);
  }
  const authority: WindowsAuthority<T> = {
    id,
    read,
    write: async (value) => {
      if (value.kind === 'value' && !io.validate(value.value)) {
        throw new AuthorityError('INVALID_VALUE', `Invalid value for ${id}`);
      }
      if (value.kind === 'missing') await io.removeRaw(); else await io.writeRaw(value.value);
      const actual = await read();
      if (!storedValueEquals(actual, value)) throw new AuthorityError('READBACK_MISMATCH', `Readback did not match ${id}`);
    },
  };
  return Object.freeze(authority);
}
