import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { REGION_CODES, type RegionCode } from '../domain/region.js';
import { StateRepository, BackupRepository, type MutationCoordinatorCapability } from '../state/repository.js';
import { createFileMutationCoordinator } from '../state/mutation-coordinator.js';
import { TransactionJournalRepository } from '../state/journal.js';
import { statePaths } from '../state/paths.js';
import {
  migrateLegacyProtection,
  NodeLegacyBackupConversionStore,
  NodeLegacyEvidenceStore,
  RepositoryMigrationStateStore,
  type LegacyProtectionClassifier,
  type MigrationResult,
} from '../state/migration.js';
import { createNativePersistAuthoritySet } from '../platform/windows/native-backend.js';
import type { ExecutableAuthority } from './executor.js';
import { DEEP_ONLY_STEP_IDS, STANDARD_STEP_IDS, type PersistStepId } from './steps.js';
import { desiredValues } from './targets.js';
import { storedValueEquals } from '../state/schema.js';
import { PersistApplicationService } from './application.js';

export type PersistRuntimeErrorCode = 'UNSUPPORTED_PLATFORM' | 'INITIALIZATION_FAILED' | 'MIGRATION_RECOVERY_REQUIRED';
export class PersistRuntimeError extends Error {
  constructor(readonly code: PersistRuntimeErrorCode, message: string, readonly migration?: MigrationResult) {
    super(message);
    this.name = 'PersistRuntimeError';
  }
}

export function defaultPersistRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const appData = environment.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'cc-fix');
}

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
}>;

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
  const stateRepository = new StateRepository({ root, mutationCoordinator: coordinator });
  const backupRepository = new BackupRepository({ root, mutationCoordinator: coordinator });
  const migration = await migrateLegacyProtection({
    root,
    coordinator,
    stateStore: new RepositoryMigrationStateStore(stateRepository),
    backupStore: new NodeLegacyBackupConversionStore({ root }),
    evidenceStore: new NodeLegacyEvidenceStore(),
    classifier: createAuthorityLegacyClassifier(authorities),
  });
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
  });
}
