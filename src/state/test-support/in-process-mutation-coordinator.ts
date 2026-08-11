import type { MutationCoordinator, MutationScope } from '../repository.js';

/** @internal Single-process test capability only. T07 supplies the production cross-process lock. */
export class InProcessTestMutationCoordinator implements MutationCoordinator {
  readonly scopes: MutationScope[] = [];

  async runExclusive<T>(scope: MutationScope, action: () => Promise<T>): Promise<T> {
    this.scopes.push(scope);
    return action();
  }
}
