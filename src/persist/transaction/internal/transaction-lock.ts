import { mutationRootGateKey, runWithHeldMutationRoot, type MutationCoordinatorCapability } from '../../../state/repository.js';
import { MutationRecoveryRequiredError } from '../../../state/mutation-coordinator.js';

async function acquireRootGate(
  root: string,
  coordinator: MutationCoordinatorCapability,
  operation: 'persist.protect' | 'persist.restore' | 'persist.recover',
) {
  const request = { lockKey: mutationRootGateKey(root), stateRoot: root, filePath: root, operation };
  try {
    return await coordinator.acquire(request);
  } catch (error) {
    // issue #51 H1：崩溃残留的锁会先以 recovery_required 暴露。普通变更保持
    // fail-closed（把用户引导到 `cc-fix persist recover`）；只有恢复流程可以
    // 接管"持有者已确认死亡"的锁，随后在锁内依据 journal 收敛中断的事务。
    if (operation !== 'persist.recover' || !(error instanceof MutationRecoveryRequiredError)) throw error;
    return await coordinator.acquire({ ...request, recoveryComplete: true });
  }
}

export async function withPersistTransactionLock<T>(
  root: string,
  coordinator: MutationCoordinatorCapability,
  operation: 'persist.protect' | 'persist.restore' | 'persist.recover',
  action: () => Promise<T>,
): Promise<T> {
  const lock = await acquireRootGate(root, coordinator, operation);
  let result: T;
  let actionError: unknown;
  try { result = await runWithHeldMutationRoot(root, action); }
  catch (error) { actionError = error; }
  try { await lock.release(); }
  catch (releaseError) {
    if (actionError !== undefined) throw new AggregateError([actionError, releaseError], 'Persist transaction and lock release both failed');
    throw releaseError;
  }
  if (actionError !== undefined) throw actionError;
  return result!;
}
