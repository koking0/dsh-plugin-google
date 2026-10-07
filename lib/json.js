/**
 * 工具输出的 JSON 规整。
 *
 * DSH 会校验工具返回值能否**无损**地 JSON 序列化：`undefined`、函数、`Symbol`、
 * `NaN`/`Infinity`、`Date` 等都会让整次调用失败（`value is not lossless JSON`）。
 *
 * 各工具实现里大量使用 `xxx: cond ? value : undefined` 表达「该字段不适用」，
 * 这在普通 JS 里很自然，但会在协议边界处被拒绝。与其要求每个工具自己小心，
 * 不如在注册层统一清洗一次——本模块因此被单独抽出，既可被入口复用，
 * 也能在单元测试里直接验证。
 *
 * @module dsh-plugin-google/lib/json
 */

/**
 * 把任意值规整成可无损 JSON 序列化的值。
 *
 * - 对象里值为 `undefined` 的键会被丢弃（与 `JSON.stringify` 语义一致）；
 * - 数组里的 `undefined` 会变成 `null`（同样与 `JSON.stringify` 一致）；
 * - `NaN` / `Infinity` 变成 `null`；`Date` 变成 ISO 字符串；`BigInt` 变数字。
 *
 * @param {any} value - 任意工具输出值。
 * @returns {any} 可无损 JSON 序列化的值。
 */
export function toLosslessJson(value) {
  if (value === undefined || value === null) return null;
  const type = typeof value;
  if (type === 'function' || type === 'symbol') return null;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'bigint') return Number(value);
  if (type !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toLosslessJson(item));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] = toLosslessJson(item);
  }
  return out;
}

/**
 * 判断一个值是否是「纯 JSON 数据」——即 JSON 往返后与原值完全一致。
 *
 * 注意不能简单地比较 `JSON.stringify` 的前后结果：`Date`、`undefined` 之类
 * 会被序列化悄悄改写（Date 变字符串、undefined 被丢弃），但信息已经丢失，
 * 所以必须逐个节点检查类型。
 *
 * @param {any} value - 待检查的值。
 * @returns {{ ok: boolean, detail?: string, path?: string }} 检查结果。
 */
export function isLosslessJson(value) {
  const walk = (node, path) => {
    if (node === null) return undefined;
    const type = typeof node;
    if (type === 'string' || type === 'boolean') return undefined;
    if (type === 'number') return Number.isFinite(node) ? undefined : `${path} 是 ${node}`;
    if (type !== 'object') return `${path} 的类型是 ${type}，无法用 JSON 表达`;
    if (node instanceof Date) return `${path} 是 Date（JSON 往返后会变成字符串）`;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const problem = walk(node[index], `${path}[${index}]`);
        if (problem) return problem;
      }
      return undefined;
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) {
      return `${path} 的原型不是普通对象（${proto?.constructor?.name ?? 'null'}）`;
    }
    for (const [key, item] of Object.entries(node)) {
      if (item === undefined) return `${path}.${key} 是 undefined`;
      const problem = walk(item, `${path}.${key}`);
      if (problem) return problem;
    }
    return undefined;
  };

  const problem = walk(value, '$');
  return problem ? { ok: false, detail: problem, path: problem } : { ok: true };
}
