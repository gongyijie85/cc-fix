// 类型守卫共享模块测试（#73/#79 统一来源）

import { describe, expect, it } from 'vitest';
import { hasExactKeys, hasOnlyKeys, isPlainRecord, isRecord } from './type-guards.js';

describe('type guards', () => {
  it('isRecord rejects arrays, null and primitives', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('isPlainRecord also accepts null-prototype objects', () => {
    expect(isPlainRecord(Object.create(null))).toBe(true);
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(null)).toBe(false);
  });

  it('hasExactKeys requires key-set equality', () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ['a', 'b'])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBe(false);
  });

  it('hasOnlyKeys allows missing keys but rejects undeclared ones', () => {
    expect(hasOnlyKeys({ a: 1 }, ['a', 'b'])).toBe(true);
    expect(hasOnlyKeys({ a: 1, c: 3 }, ['a', 'b'])).toBe(false);
  });
});
