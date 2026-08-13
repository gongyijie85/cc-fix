import { deleteEnvVar, getEnvVar, getSystemTimezone, getUserCulture, getUserLanguageTags, getWindowsLocaleName, setEnvVar, setSystemTimezone, setUserCulture, setUserLanguageListPrimary, setWindowsLocaleName } from '../windows.js';
import { deletePolicy, getPolicy, setPolicy } from '../browser.js';
import { BROWSER_POLICY_SLOTS } from '../../state/schema.js';
import type { BrowserPolicyRegistry } from './browser-policy.js';
import type { EnvironmentRegistry } from './environment.js';
import type { LocaleRegistry } from './locale.js';
import type { TimezoneSystem, ApprovedWindowsTimezone } from './timezone.js';

/** Production bridge; callers can only reach it through the constrained authorities. */
export const legacyEnvironmentRegistry: EnvironmentRegistry = { read: async (key) => getEnvVar(key), write: async (key, value) => setEnvVar(key, value), remove: async (key) => deleteEnvVar(key) };
export const legacyTimezoneSystem: TimezoneSystem = { read: async () => getSystemTimezone(), write: async (id: ApprovedWindowsTimezone) => setSystemTimezone(id) };
export const legacyBrowserPolicyRegistry: BrowserPolicyRegistry = {
  read: async (id) => { const slot = BROWSER_POLICY_SLOTS.find((candidate) => candidate.id === id)!; return getPolicy(slot.browser, slot.valueName); },
  write: async (id, value) => { const slot = BROWSER_POLICY_SLOTS.find((candidate) => candidate.id === id)!; setPolicy(slot.browser, slot.valueName, value); },
  remove: async (id) => { const slot = BROWSER_POLICY_SLOTS.find((candidate) => candidate.id === id)!; deletePolicy(slot.browser, slot.valueName); },
};
export const legacyLocaleRegistry: LocaleRegistry = {
  readLocale: async () => getWindowsLocaleName(), writeLocale: async (value) => setWindowsLocaleName(value), removeLocale: async () => { throw new Error('LocaleName removal is unsupported by legacy backend'); },
  readLanguages: async () => getUserLanguageTags(), writeLanguages: async (value) => { if (value.length !== 1) throw new Error('Legacy backend cannot restore multiple languages'); setUserLanguageListPrimary(value[0]!); }, removeLanguages: async () => { throw new Error('Language removal is unsupported by legacy backend'); },
  readCulture: async () => getUserCulture(), writeCulture: async (value) => setUserCulture(value), removeCulture: async () => { throw new Error('Culture removal is unsupported by legacy backend'); },
};
