// 共享类型守卫 — schema.ts 与 migration.ts 的 isRecord/hasExactKeys 统一来源

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 原型必须是 Object.prototype 或 null（拒绝 JSON 解析外的自定义原型对象）。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** 键集合与预期完全一致（允许的键数==实际键数，且一一对应）。 */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** 键是允许集合的子集（忽略缺失，拒绝未声明键）。 */
export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
