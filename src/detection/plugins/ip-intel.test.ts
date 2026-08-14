import { describe, expect, it } from 'vitest';
import { createIpIntelligencePlugins } from './ip-intel.js';
import type { IpIntelligence } from '../types.js';

const intel = (over: Partial<IpIntelligence>): IpIntelligence => ({
  ipType: 'residential', asn: 'AS13335', org: 'Cloudflare', sourceCount: 2, multiSourceConsistent: true, ...over,
});

describe('ip intelligence plugins', () => {
  it('emits nothing for null intel and nothing when all conditions hold', () => {
    expect(createIpIntelligencePlugins(null)).toEqual([]);
    expect(createIpIntelligencePlugins(intel({}))).toEqual([]);
  });

  it('emits datacenter and multi-source signals with the exact legacy fields', async () => {
    const plugins = createIpIntelligencePlugins(intel({ ipType: 'datacenter', multiSourceConsistent: false }));
    expect(plugins.map(p => p.id)).toEqual(['ip-datacenter', 'ip-multi-source']);
    const dc = await plugins[0].run({ targetTimezone: 't', targetLang: 'en' });
    expect(dc).toMatchObject({ id: 'ip-datacenter', value: 'AS13335 (Cloudflare)', score: 1, weight: 13, contribution: 13, source: 'network', risk: 'high' });
    const ms = await plugins[1].run({ targetTimezone: 't', targetLang: 'en' });
    expect(ms).toMatchObject({ id: 'ip-multi-source', value: '2 个情报源结果不一致', weight: 15, contribution: 15 });
  });

  it('emits only the multi-source signal when consistent datacenter', () => {
    const plugins = createIpIntelligencePlugins(intel({ ipType: 'datacenter', multiSourceConsistent: true }));
    expect(plugins.map(p => p.id)).toEqual(['ip-datacenter']);
  });
});
