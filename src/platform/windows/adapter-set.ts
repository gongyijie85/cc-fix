import type { ExecutableAuthority } from '../../persist/executor.js';
import type { PersistStepId } from '../../persist/steps.js';
import type { WindowsAuthority } from './authority.js';

/** Narrows the application boundary to the six approved persist authorities. */
export function createPersistAuthoritySet(input: Readonly<Record<PersistStepId, WindowsAuthority<any>>>): Readonly<Record<PersistStepId, ExecutableAuthority>> {
  return Object.freeze(Object.fromEntries(Object.entries(input).map(([id, authority]) => [id, { read: () => authority.read(), write: (value) => authority.write(value) }])) as Record<PersistStepId, ExecutableAuthority>);
}
