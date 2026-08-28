// 信号目录测试 — 服务端唯一目录的 id/label 契约

import { describe, expect, it } from 'vitest';
import { signalCatalog } from './catalog.js';

describe('signalCatalog', () => {
  it('返回 13 个信号项且 id/label 完整', () => {
    const catalog = signalCatalog();
    expect(catalog).toHaveLength(13);
    for (const entry of catalog) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it('顺序与运行器一致（检测项在前，IP 派生在末）', () => {
    const ids = signalCatalog().map((entry) => entry.id);
    expect(ids.slice(0, 4)).toEqual(['timezone', 'language', 'locale', 'consistency']);
    expect(ids.slice(-2)).toEqual(['ip-datacenter', 'ip-multi-source']);
  });

  it('包含浏览器策略与网络类信号', () => {
    const ids = signalCatalog().map((entry) => entry.id);
    expect(ids).toContain('browser-policy');
    expect(ids).toContain('dns');
    expect(ids).toContain('fonts');
    expect(ids).toContain('win-region');
  });

  it('一致性条目引用真实插件 id/label', () => {
    const entry = signalCatalog().find((item) => item.id === 'consistency');
    expect(entry?.label).toBeTruthy();
  });
});
