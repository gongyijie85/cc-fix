import { isAbsolute, join, resolve } from 'node:path';
import { access, mkdir, open, readFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REGION_CODES, type RegionCode } from '../domain/region.js';
import { StateRepository, BackupRepository, type MutationCoordinatorCapability } from '../state/repository.js';
import { createFileMutationCoordinator } from '../state/mutation-coordinator.js';
import { TransactionJournalRepository } from '../state/journal.js';
import { defaultPersistRoot, statePaths } from '../state/paths.js';
import {
  migrateLegacyProtection,
  NodeLegacyBackupConversionStore,
  NodeLegacyEvidenceStore,
  RepositoryMigrationStateStore,
  type LegacyProtectionClassifier,
  type MigrationResult,
} from '../state/migration.js';
import { createNativePersistAuthoritySet } from '../platform/windows/native-backend.js';
import type { ExecutableAuthority } from './authority.js';
import { DEEP_ONLY_STEP_IDS, STANDARD_STEP_IDS, type PersistStepId } from './steps.js';
import { desiredValues } from './targets.js';
import { storedValueEquals } from '../state/schema.js';
import { PersistApplicationService } from './application.js';
import { createNativeHelperFileSystem } from '../state/native-helper-filesystem.js';
import { createVerifiedBackupDelete, createVerifiedBackupDeleteAuthority } from './verified-backup-delete.js';

export type PersistRuntimeErrorCode = 'UNSUPPORTED_PLATFORM' | 'INITIALIZATION_FAILED' | 'MIGRATION_RECOVERY_REQUIRED';
export class PersistRuntimeError extends Error {
  constructor(readonly code: PersistRuntimeErrorCode, message: string, readonly migration?: MigrationResult) {
    super(message);
    this.name = 'PersistRuntimeError';
  }
}

export { defaultPersistRoot };

/** Classifies legacy v3 state from all six constrained authorities, never from backup existence. */
export function createAuthorityLegacyClassifier(
  authorities: Readonly<Record<PersistStepId, ExecutableAuthority>>,
): LegacyProtectionClassifier {
  return {
    classify: async () => {
      const actual = Object.fromEntries(await Promise.all(
        [...STANDARD_STEP_IDS, ...DEEP_ONLY_STEP_IDS].map(async (id) => [id, await authorities[id].read()] as const),
      )) as Record<PersistStepId, Awaited<ReturnType<ExecutableAuthority['read']>>>;
      const candidates = [] as Array<{ mode: 'standard' | 'deep'; region: RegionCode }>;
      for (const region of REGION_CODES) {
        const target = desiredValues({ mode: 'deep', region });
        const standardAligned = STANDARD_STEP_IDS.every((id) => storedValueEquals(actual[id], target[id]));
        if (!standardAligned) continue;
        const deepAligned = DEEP_ONLY_STEP_IDS.every((id) => storedValueEquals(actual[id], target[id]));
        candidates.push({ mode: deepAligned ? 'deep' : 'standard', region });
      }
      return { candidates };
    },
  };
}

export type PersistRuntimeOptions = Readonly<{
  root?: string;
  coordinator?: MutationCoordinatorCapability;
  authorities?: Readonly<Record<PersistStepId, ExecutableAuthority>>;
  platform?: NodeJS.Platform;
  nativeHelperPath?: string;
}>;

/**
 * 解析 native-helper 可执行文件路径（issue #53 安全强化）：
 *
 * 1. 显式参数（开发/测试，相对路径按 CWD 解析——调用方自担）
 * 2. bundle 相对布局 `<dist>/../native/cc-fix-native-helper.exe`（npm 与桌面载荷的正式位置）
 * 3. 环境变量 `CC_FIX_NATIVE_HELPER`——仅接受**绝对路径**，且排在 bundle 之后：
 *    合法安装永远命中 bundle，环境变量退化为开发兜底；同用户持久攻击者设置的
 *    相对路径（配合不可信 CWD 的预置目录）不再被解析
 *
 * 已移除 `join(process.cwd(), 'native-helper', ...)` 回退：在下载目录/网络共享等
 * 不可信目录运行 CLI 时，攻击者预置的同名路径会被直接执行。
 *
 * 若候选旁存在 `<candidate>.sha256` sidecar（打包脚本生成），先做字节级哈希校验，
 * 不匹配即 fail-closed——为无 Authenticode 的分发提供篡改可见性（纵深防御，
 * 非信任根：sidecar 本身与 exe 同目录，防不了有写权限的定向替换）。
 */
export async function resolveNativeHelperPath(explicit?: string): Promise<string | undefined> {
  const candidates: string[] = [];
  if (typeof explicit === 'string' && explicit.length > 0) candidates.push(resolve(explicit));
  candidates.push(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'native', 'cc-fix-native-helper.exe'));
  const fromEnv = process.env.CC_FIX_NATIVE_HELPER;
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && isAbsolute(fromEnv)) candidates.push(fromEnv);
  for (const candidate of candidates) {
    try { await access(candidate); } catch { continue; }
    await assertHelperMatchesSidecar(candidate);
    return candidate;
  }
  return undefined;
}

async function assertHelperMatchesSidecar(candidate: string): Promise<void> {
  let expected: string;
  try {
    expected = (await readFile(`${candidate}.sha256`, 'utf8')).trim().toLowerCase();
  } catch {
    return; // 无 sidecar（npm/dev 布局）：跳过校验
  }
  const actual = createHash('sha256').update(await readFile(candidate)).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
    throw new PersistRuntimeError(
      'INITIALIZATION_FAILED',
      `Native helper digest mismatch for ${candidate}: sidecar says ${expected || '(malformed)'}, binary is ${actual}`,
    );
  }
}

/** Opens and safely initializes/migrates the production persist state. */
export async function createPersistRuntime(options: PersistRuntimeOptions = {}): Promise<PersistApplicationService> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' && options.authorities === undefined) {
    throw new PersistRuntimeError('UNSUPPORTED_PLATFORM', 'Persistent protection is supported on Windows only');
  }
  const root = options.root ?? defaultPersistRoot();
  if (!isAbsolute(root)) throw new PersistRuntimeError('INITIALIZATION_FAILED', 'Persist root must be absolute');
  await mkdir(root, { recursive: true });
  const coordinator = options.coordinator ?? createFileMutationCoordinator();
  const authorities = options.authorities ?? createNativePersistAuthoritySet();
  const helperPath = await resolveNativeHelperPath(options.nativeHelperPath);
  const filesystem = helperPath === undefined ? undefined : createNativeHelperFileSystem({ root, helperPath });
  const deleteAuthority = helperPath === undefined ? undefined : createVerifiedBackupDeleteAuthority();
  const stateRepository = new StateRepository({ root, mutationCoordinator: coordinator });
  const backupRepository = new BackupRepository({
    root,
    mutationCoordinator: coordinator,
    ...(filesystem === undefined ? {} : { filesystem }),
    ...(deleteAuthority === undefined ? {} : { verifiedRestoreAuthority: deleteAuthority.capability }),
  });
  // issue #58：迁移哨兵。迁移一旦收敛（migrated/noop）就原子写哨兵；此后每次
  // runtime 创建先无锁 stat 哨兵，命中即跳过 migrateLegacyProtection——已迁移用户
  // 的每条 persist 子命令不再付"拿 root 锁 + 查询进程 StartTime + classifier 读全部
  // 权威"的开销。哨兵只在收敛后写；recovery_required/failed 不写（下次重试）。
  // 哨兵含版本号：将来 schema 升级改版本即可强制重新迁移。哨兵被删只会触发一次
  // 幂等重迁移，无正确性风险。
  let migration: MigrationResult;
  if (await readMigrationSentinel(root)) {
    migration = Object.freeze({ kind: 'noop' as const, reason: 'already_initialized' as const, committedTarget: null, stateWritten: false });
  } else {
    migration = await migrateLegacyProtection({
      root,
      coordinator,
      stateStore: new RepositoryMigrationStateStore(stateRepository),
      backupStore: new NodeLegacyBackupConversionStore({ root, ...(filesystem === undefined ? {} : { filesystem }) }),
      evidenceStore: new NodeLegacyEvidenceStore(),
      classifier: createAuthorityLegacyClassifier(authorities),
    });
    if (migration.kind === 'migrated' || migration.kind === 'noop') {
      await writeMigrationSentinel(root);
    }
  }
  if (migration.kind === 'recovery_required') {
    throw new PersistRuntimeError(
      'MIGRATION_RECOVERY_REQUIRED',
      `Legacy persist state needs explicit recovery: ${migration.reason}`,
      migration,
    );
  }
  if (migration.kind === 'failed') {
    throw new PersistRuntimeError('INITIALIZATION_FAILED', `Persist state initialization failed: ${migration.reason}`, migration);
  }
  return new PersistApplicationService({
    root,
    coordinator,
    stateRepository,
    backupRepository,
    journalRepository: new TransactionJournalRepository(root, statePaths(root).journal),
    authorities,
    ...(deleteAuthority === undefined ? {} : {
      deleteDailySnapshot: createVerifiedBackupDelete(backupRepository, deleteAuthority),
    }),
  });
}

const MIGRATION_SENTINEL_VERSION = 1;

function migrationSentinelPath(root: string): string {
  return join(root, 'legacy-migration.json');
}

async function readMigrationSentinel(root: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(migrationSentinelPath(root), 'utf8')) as { schemaVersion?: unknown };
    return parsed.schemaVersion === MIGRATION_SENTINEL_VERSION;
  } catch {
    return false;
  }
}

// #100：哨兵走 fsync + 原子替换（与状态文件同一耐久语义）。失败保持幂等：
// 下次运行重新迁移（noop），无正确性影响。
async function writeMigrationSentinel(root: string): Promise<void> {
  let handle;
  try {
    const sentinel = migrationSentinelPath(root);
    const tmp = `${sentinel}.${randomUUID()}.tmp`;
    handle = await open(tmp, 'w');
    await handle.writeFile(JSON.stringify({ schemaVersion: MIGRATION_SENTINEL_VERSION, migratedAt: new Date().toISOString() }), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, sentinel);
    try {
      const dir = await open(root, 'r');
      try { await dir.sync(); } catch { /* Windows 目录 fsync 不可用属已知限制 */ }
      await dir.close();
    } catch { /* 目录同步尽力而为 */ }
  } catch {
    try { await handle?.close(); } catch { /* ignore */ }
  }
}
