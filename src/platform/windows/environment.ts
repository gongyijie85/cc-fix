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

export type EnvironmentProfile = { TZ: string | null; LANG: string | null; LC_ALL: string | null };

/** The executor treats the three related environment variables as one compensated step. */
export function createEnvironmentProfileAuthority(registry: EnvironmentRegistry): WindowsAuthority<EnvironmentProfile> {
  return createWindowsAuthority('environment', {
    readRaw: async () => ({
      TZ: await registry.read('TZ'), LANG: await registry.read('LANG'), LC_ALL: await registry.read('LC_ALL'),
    }),
    writeRaw: async (value) => {
      for (const key of MANAGED_ENVIRONMENT_KEYS) {
        const next = value[key];
        if (next === null) await registry.remove(key); else await registry.write(key, next);
      }
    },
    removeRaw: async () => { for (const key of MANAGED_ENVIRONMENT_KEYS) await registry.remove(key); },
    validate: (value): value is EnvironmentProfile => typeof value === 'object' && value !== null
      && Object.keys(value).length === 3 && MANAGED_ENVIRONMENT_KEYS.every((key) => typeof (value as Record<string, unknown>)[key] === 'string' || (value as Record<string, unknown>)[key] === null),
  });
}
