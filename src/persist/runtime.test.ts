import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InProcessTestMutationCoordinator } from '../state/test-support/in-process-mutation-coordinator.js';
import { storedValue, type StoredValue } from '../state/schema.js';
import type { JsonValue } from '../state/checksum.js';
import type { PersistStepId } from './steps.js';
import { desiredValues } from './targets.js';
import { createAuthorityLegacyClassifier, createPersistRuntime, defaultPersistRoot } from './runtime.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const ids = ['environment','system_timezone','browser_policies','locale_name','user_languages','user_culture'] as const;

function authorities(values: Record<PersistStepId, StoredValue<JsonValue>>) {
  return Object.fromEntries(ids.map((id) => [id, {
    read: async () => values[id],
    write: async (next: StoredValue<JsonValue>) => { values[id] = next; },
  }])) as never;
}

describe('persist runtime composition', () => {
  it('initializes a clean daily repository and exposes committed-state status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-runtime-'));
    roots.push(root);
    const values = desiredValues({ mode: 'deep', region: 'us' }) as Record<PersistStepId, StoredValue<JsonValue>>;
    const service = await createPersistRuntime({
      root,
      platform: 'linux',
      coordinator: new InProcessTestMutationCoordinator().capability,
      authorities: authorities(values),
    });
    await expect(service.status()).resolves.toMatchObject({ mode: 'daily', target: null, health: 'healthy' });
  });

  it('classifies exactly one aligned region and prefers deep over its standard subset', async () => {
    const values = { ...desiredValues({ mode: 'deep', region: 'jp' }) } as Record<PersistStepId, StoredValue<JsonValue>>;
    await expect(createAuthorityLegacyClassifier(authorities(values)).classify()).resolves.toEqual({
      candidates: [{ mode: 'deep', region: 'jp' }],
    });
    values.locale_name = storedValue('zh-CN');
    await expect(createAuthorityLegacyClassifier(authorities(values)).classify()).resolves.toEqual({
      candidates: [{ mode: 'standard', region: 'jp' }],
    });
  });

  it('derives the per-user root from APPDATA and rejects unsupported production hosts', async () => {
    expect(defaultPersistRoot({ APPDATA: 'D:\\Profiles\\Me\\Roaming' })).toBe('D:\\Profiles\\Me\\Roaming\\cc-fix');
    await expect(createPersistRuntime({ platform: 'linux' })).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
  });
});
