import {
  issueMutationCoordinatorCapability,
  type MutationCoordinatorCapability,
  type MutationLockRequest,
} from '../internal/capabilities.js';

/** @internal Single-process test issuer only. T07 supplies the production cross-process lock. */
export class InProcessTestMutationCoordinator {
  readonly requests: MutationLockRequest[] = [];
  readonly capability: MutationCoordinatorCapability;
  private readonly active = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor() {
    this.capability = issueMutationCoordinatorCapability({
      acquire: async (request) => {
        if (this.active.has(request.lockKey)) {
          await new Promise<void>((resolve) => {
            const queue = this.waiters.get(request.lockKey) ?? [];
            queue.push(resolve);
            this.waiters.set(request.lockKey, queue);
          });
        }
        this.requests.push(request);
        this.active.add(request.lockKey);
        return {
          release: async () => {
            this.active.delete(request.lockKey);
            const next = this.waiters.get(request.lockKey)?.shift();
            if (next !== undefined) next();
            if (this.waiters.get(request.lockKey)?.length === 0) this.waiters.delete(request.lockKey);
          },
        };
      },
    });
  }

  get scopes(): MutationLockRequest[] {
    return this.requests;
  }
}
