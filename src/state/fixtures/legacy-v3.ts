import type { RegionCode } from '../../domain/region.js';

export const LEGACY_BROWSER_SLOT_KEYS = [
  'chrome/AcceptLanguage',
  'chrome/DefaultWebRtcIPHandlingPolicy',
  'chrome/ApplicationLocaleValue',
  'edge/AcceptLanguage',
  'edge/DefaultWebRtcIPHandlingPolicy',
  'edge/ApplicationLocaleValue',
] as const;

export function completeLegacyV3(region: RegionCode = 'us'): Record<string, unknown> {
  return {
    timestamp: '2026-01-02T03:04:05.000Z',
    schemaVersion: 3,
    activeRegion: region,
    previous: { TZ: null, LANG: '', LC_ALL: 'daily-locale' },
    previousSystemTimezone: 'China Standard Time',
    previousBrowserPolicies: {
      'chrome/AcceptLanguage': null,
      'chrome/DefaultWebRtcIPHandlingPolicy': 'daily-chrome-webrtc',
      'chrome/ApplicationLocaleValue': '',
      'edge/AcceptLanguage': 'daily-edge-language',
      'edge/DefaultWebRtcIPHandlingPolicy': null,
      'edge/ApplicationLocaleValue': 'daily-edge-locale',
    },
    previousLocaleName: 'zh-CN',
    previousUserLanguages: [],
    previousUserCulture: 'zh-CN',
  };
}

export function legacyBytes(region: RegionCode = 'us'): Buffer {
  return Buffer.from(`${JSON.stringify(completeLegacyV3(region), null, 2)}\n`, 'utf8');
}
