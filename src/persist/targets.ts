import { getTargetRegion } from '../detection/regions.js';
import { targetPolicies } from '../platform/browser.js';
import { storedValue, type StoredValue } from '../state/schema.js';
import type { JsonValue } from '../state/checksum.js';
import type { ProtectionTarget } from '../domain/protection.js';
import type { PersistStepId } from './steps.js';

/** Immutable desired authority values derived solely from the approved region catalogue. */
export function desiredValues(target: ProtectionTarget): Readonly<Record<PersistStepId, StoredValue<JsonValue>>> {
  const region = getTargetRegion(target.region);
  const locale = region.lang.split('.')[0]!.replace('_', '-');
  const standard = {
    environment: storedValue({ TZ: region.timezone, LANG: region.lang, LC_ALL: region.lcAll }),
    system_timezone: storedValue(region.winTimezone),
    browser_policies: storedValue(targetPolicies(region.lang)),
  };
  return Object.freeze({
    ...standard,
    locale_name: storedValue(locale),
    user_languages: storedValue([locale]),
    user_culture: storedValue(locale),
  });
}
