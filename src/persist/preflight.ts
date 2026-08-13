import type { PersistStatus } from './service.js';

export const INSTALLER_PREFLIGHT_BLOCKED_EXIT = 43;

/** Stable installer contract: replacement is safe only with no recovery work in flight. */
export function installerPreflightExitCode(status: PersistStatus): 0 | typeof INSTALLER_PREFLIGHT_BLOCKED_EXIT {
  return status.health !== 'recovery_required' && status.transaction.kind === 'none'
    ? 0
    : INSTALLER_PREFLIGHT_BLOCKED_EXIT;
}
