import type { ProtectionTarget } from '../domain/protection.js';
import type { RegionCode } from '../domain/region.js';
import {
  createPersistTransactionModule,
  type PersistApplicationDependencies,
  type PersistTransactionModule,
} from './transaction/index.js';
import type { PersistStatus, ProtectTransactionResult } from './transaction/index.js';
import type { RestoreTransactionResult } from './transaction/index.js';
import type { PersistRecoveryResult } from './transaction/index.js';

export {
  PersistApplicationError,
  type PersistApplicationErrorCode,
  type PersistApplicationDependencies,
} from './transaction/index.js';

/** The sole application boundary for protected-mode state transitions. 生命周期实现集中于事务模块（ADR-0012）。 */
export class PersistApplicationService {
  private readonly transactions: PersistTransactionModule;

  constructor(dependencies: PersistApplicationDependencies) {
    this.transactions = createPersistTransactionModule(dependencies);
  }

  status(): Promise<PersistStatus> {
    return this.transactions.status();
  }

  protect(target: ProtectionTarget): Promise<ProtectTransactionResult> {
    return this.transactions.protect(target);
  }

  restore(): Promise<RestoreTransactionResult> {
    return this.transactions.restore();
  }

  recover(): Promise<PersistRecoveryResult> {
    return this.transactions.recover();
  }

  /** 日常态偏好地区更新；保护态拒绝并引导正式目标转换（#116）。 */
  setPreferredRegion(region: RegionCode): Promise<{ kind: 'updated' | 'noop'; preferredRegion: RegionCode }> {
    return this.transactions.setPreferredRegion(region);
  }
}
