import { createWindowsAuthority, type WindowsAuthority } from './authority.js';

export const MANAGED_ENVIRONMENT_KEYS = ['TZ', 'LANG', 'LC_ALL'] as const;
export type ManagedEnvironmentKey = (typeof MANAGED_ENVIRONMENT_KEYS)[number];

export interface EnvironmentRegistry {
  read(key: ManagedEnvironmentKey): Promise<string | null>;
  write(key: ManagedEnvironmentKey, value: string): Promise<void>;
  remove(key: ManagedEnvironmentKey): Promise<void>;
}

export function createEnvironmentAuthority(
  registry: EnvironmentRegistry,
  key: ManagedEnvironmentKey,
): WindowsAuthority<string> {
  if (!MANAGED_ENVIRONMENT_KEYS.includes(key)) throw new Error('Unmanaged environment key');
  return createWindowsAuthority(`environment.${key}`, {
    readRaw: () => registry.read(key),
    writeRaw: (value) => registry.write(key, value),
    removeRaw: () => registry.remove(key),
    validate: (value): value is string => typeof value === 'string',
  });
}
