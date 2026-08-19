import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { InProcessTestMutationCoordinator } from '../state/test-support/in-process-mutation-coordinator.js';
import { storedValue, type StoredValue } from '../state/schema.js';
import type { JsonValue } from '../state/checksum.js';
import type { PersistStepId } from './steps.js';
import { desiredValues } from './targets.js';
import { createAuthorityLegacyClassifier, createPersistRuntime, defaultPersistRoot, resolveNativeHelperPath } from './runtime.js';
import { completeLegacyV3 } from '../state/fixtures/legacy-v3.js';

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
    values.environment = storedValue({ TZ: 'invalid', LANG: 'invalid', LC_ALL: 'invalid' });
    await expect(createAuthorityLegacyClassifier(authorities(values)).classify()).resolves.toEqual({ candidates: [] });
  });

  it('derives the per-user root from APPDATA and rejects unsupported production hosts', async () => {
    expect(defaultPersistRoot({ APPDATA: 'D:\\Profiles\\Me\\Roaming' })).toBe('D:\\Profiles\\Me\\Roaming\\cc-fix');
    expect(defaultPersistRoot({})).toMatch(/[\\/]AppData[\\/]Roaming[\\/]cc-fix$/);
    await expect(createPersistRuntime({ platform: 'linux' })).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
    await expect(createPersistRuntime({ root: 'relative', platform: 'linux', authorities: authorities(desiredValues({ mode: 'deep', region: 'us' }) as never) })).rejects.toMatchObject({ code: 'INITIALIZATION_FAILED' });
  });

  it('maps corrupt and incomplete legacy backups to distinct fail-closed runtime errors', async () => {
    const corruptRoot = await mkdtemp(join(tmpdir(), 'cc-fix-runtime-corrupt-'));
    const incompleteRoot = await mkdtemp(join(tmpdir(), 'cc-fix-runtime-incomplete-'));
    roots.push(corruptRoot, incompleteRoot);
    await writeFile(join(corruptRoot, 'persist-backup.json'), '{');
    const incomplete = completeLegacyV3();
    delete incomplete.previousLocaleName;
    await writeFile(join(incompleteRoot, 'persist-backup.json'), JSON.stringify(incomplete));
    const values = desiredValues({ mode: 'deep', region: 'us' }) as Record<PersistStepId, StoredValue<JsonValue>>;
    const options = { platform: 'linux' as const, coordinator: new InProcessTestMutationCoordinator().capability, authorities: authorities(values) };
    await expect(createPersistRuntime({ ...options, root: corruptRoot })).rejects.toMatchObject({ code: 'INITIALIZATION_FAILED' });
    await expect(createPersistRuntime({ ...options, root: incompleteRoot })).rejects.toMatchObject({ code: 'MIGRATION_RECOVERY_REQUIRED' });
  });

  const releaseHelper = join(process.cwd(), 'native-helper', 'target', 'release', 'cc-fix-native-helper.exe');
  it.skipIf(!existsSync(releaseHelper))('completes protect and off with the real native compare-delete helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-runtime-native-'));
    roots.push(root);
    const values = {
      environment: storedValue({ TZ: null, LANG: null, LC_ALL: null }),
      system_timezone: storedValue('China Standard Time'),
      browser_policies: storedValue(Object.fromEntries([
        'chrome.accept_language','chrome.webrtc','chrome.application_locale',
        'edge.accept_language','edge.webrtc','edge.application_locale',
      ].map((id) => [id, null]))),
      locale_name: storedValue('zh-CN'), user_languages: storedValue(['zh-CN']), user_culture: storedValue('zh-CN'),
    } as Record<PersistStepId, StoredValue<JsonValue>>;
    const service = await createPersistRuntime({
      root,
      platform: 'linux',
      coordinator: new InProcessTestMutationCoordinator().capability,
      authorities: authorities(values),
      nativeHelperPath: releaseHelper,
    });
    await expect(service.protect({ mode: 'deep', region: 'jp' })).resolves.toMatchObject({ kind: 'committable' });
    await expect(service.restore()).resolves.toEqual({ kind: 'restored' });
    await expect(service.status()).resolves.toMatchObject({ mode: 'daily', health: 'healthy' });
    expect(existsSync(join(root, 'persist-backup.json'))).toBe(false);
    expect(existsSync(join(root, 'persist-backup.json.prev'))).toBe(false);
  });
});

describe('native helper path resolution (issue #53)', () => {
  const savedEnv = process.env.CC_FIX_NATIVE_HELPER;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CC_FIX_NATIVE_HELPER;
    else process.env.CC_FIX_NATIVE_HELPER = savedEnv;
  });

  async function tempHelper(content: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-helper-resolve-'));
    roots.push(root);
    const path = join(root, 'cc-fix-native-helper.exe');
    await writeFile(path, content, 'utf8');
    return path;
  }

  it('never resolves via the removed CWD fallback, even when a repo build exists there', async () => {
    delete process.env.CC_FIX_NATIVE_HELPER;
    // 旧实现在此场景会命中 <cwd>/native-helper/target/release（仓库里真实存在）；
    // bundle 候选在 vitest 下指向 src/native（不存在）→ 新实现必须返回 undefined。
    await expect(resolveNativeHelperPath()).resolves.toBeUndefined();
  });

  it('accepts an absolute env override and ignores relative values', async () => {
    const helper = await tempHelper('fake');
    process.env.CC_FIX_NATIVE_HELPER = helper;
    await expect(resolveNativeHelperPath()).resolves.toBe(helper);
    // 相对路径环境值（配合不可信 CWD 的预置目录）不再参与解析
    process.env.CC_FIX_NATIVE_HELPER = join('native-helper', 'target', 'release', 'cc-fix-native-helper.exe');
    await expect(resolveNativeHelperPath()).resolves.toBeUndefined();
  });

  it('fails closed when the sidecar digest does not match the binary', async () => {
    const helper = await tempHelper('tampered');
    await writeFile(`${helper}.sha256`, '0'.repeat(64), 'utf8');
    process.env.CC_FIX_NATIVE_HELPER = helper;
    await expect(resolveNativeHelperPath()).rejects.toMatchObject({ code: 'INITIALIZATION_FAILED' });
  });

  it('resolves when the sidecar digest matches and tolerates a missing sidecar', async () => {
    const helper = await tempHelper('ok');
    await writeFile(`${helper}.sha256`, `${createHash('sha256').update('ok').digest('hex')}\n`, 'utf8');
    process.env.CC_FIX_NATIVE_HELPER = helper;
    await expect(resolveNativeHelperPath()).resolves.toBe(helper);
    const bare = await tempHelper('no-sidecar');
    process.env.CC_FIX_NATIVE_HELPER = bare;
    await expect(resolveNativeHelperPath()).resolves.toBe(bare);
  });
});
