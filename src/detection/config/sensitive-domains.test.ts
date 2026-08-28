// 敏感域名匹配测试 — 精确/子域名/负例边界

import { describe, expect, it } from 'vitest';
import { isSensitiveDomain } from './sensitive-domains.js';

describe('isSensitiveDomain', () => {
  it('精确匹配命中', () => {
    expect(isSensitiveDomain('https://api.deepseek.com/v1/chat')).toBe(true);
    expect(isSensitiveDomain('https://api.moonshot.cn')).toBe(true);
    expect(isSensitiveDomain('http://open.bigmodel.cn/api')).toBe(true);
  });

  it('子域名命中', () => {
    expect(isSensitiveDomain('https://chat.deepseek.com/')).toBe(true);
    expect(isSensitiveDomain('https://abc.def.api.moonshot.cn/')).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(isSensitiveDomain('https://API.DEEPSEEK.COM/')).toBe(true);
    expect(isSensitiveDomain('https://Chat.DeepSeek.com/')).toBe(true);
  });

  it('相似但不同的域名不误报（后缀边界）', () => {
    // deepseek.com 不是 deepseek.com.cn，也不是 xdeepseek.com
    expect(isSensitiveDomain('https://api.deepseek.com.cn/')).toBe(false);
    expect(isSensitiveDomain('https://xdeepseek.com/')).toBe(false);
    expect(isSensitiveDomain('https://deepseek.com.evil.com/')).toBe(false);
    // 一个后缀匹配另一个后缀前缀时不误报
    expect(isSensitiveDomain('https://deepseek.com.org/')).toBe(false);
  });

  it('普通域名不命中', () => {
    expect(isSensitiveDomain('https://api.anthropic.com/v1')).toBe(false);
    expect(isSensitiveDomain('https://www.google.com')).toBe(false);
    expect(isSensitiveDomain('https://example.com')).toBe(false);
  });

  it('非法 URL 返回 false', () => {
    expect(isSensitiveDomain('not a url')).toBe(false);
    expect(isSensitiveDomain('')).toBe(false);
    expect(isSensitiveDomain('https://')).toBe(false);
  });
});
