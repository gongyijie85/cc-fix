import { mutationRootGateKey, runWithHeldMutationRoot, type MutationCoordinatorCapability } from '../state/repository.js';

export async function withPersistTransactionLock<T>(
  root: string,
  coordinator: MutationCoordinatorCapability,
  operation: 'persist.protect' | 'persist.restore' | 'persist.recover',
  action: () => Promise<T>,
): Promise<T> {
  const lock = await coordinator.acquire({ lockKey: mutationRootGateKey(root), stateRoot: root, filePath: root, operation });
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
