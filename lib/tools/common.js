/**
 * 工具定义的公共骨架。
 *
 * 这里刻意只产出「普通对象」规格（plain spec），不导入任何 `@deepseek-ai/*` 包：
 * 入口 `index.js` 负责把规格包装成 `defineTool` 并注册到 `ctx.tools`。
 * 这样工具逻辑可以在没有 DSH 运行时的情况下被 Node 直接单元测试。
 *
 * @module dsh-plugin-google/lib/tools/common
 */

/**
 * 声明一个工具规格（identity 函数，仅用于类型与可读性）。
 * @param {object} spec - 工具规格。
 * @returns {object} 同一对象。
 */
export function toolSpec(spec) {
  return spec;
}

/** 字符串参数。 */
export function stringParam(description, required = false) {
  return required ? { type: 'string', required: true, description } : { type: 'string', description };
}

/** 整数参数。 */
export function intParam(description, required = false) {
  return required ? { type: 'integer', required: true, description } : { type: 'integer', description };
}

/** 布尔参数。 */
export function boolParam(description) {
  return { type: 'boolean', description };
}

/** 字符串数组参数。 */
export function stringListParam(description) {
  return { type: 'array', items: { type: 'string' }, description };
}

/** 整数数组参数。 */
export function intListParam(description) {
  return { type: 'array', items: { type: 'integer' }, description };
}

/** 枚举参数。 */
export function enumParam(values, description, required = false) {
  return required
    ? { type: 'string', enum: values, required: true, description }
    : { type: 'string', enum: values, description };
}

/** 所有删除类工具共用的二次确认参数。 */
export const CONFIRM_PARAM = {
  type: 'boolean',
  description: '必填且必须为 true：本操作会永久删除 Google 上的数据。请在用户明确同意后再传 true。',
};

/** 删除类工具的 `confirm` 要求（在 guard 中始终强制）。 */
export const ALWAYS_CONFIRM = { always: true };

/**
 * 归一化 `maxResults`，避免模型传入过大或非法的值。
 * @param {unknown} value - 模型传入的值。
 * @param {number} fallback - 默认值。
 * @param {number} [ceiling] - 上限。
 * @returns {number} 合法条数。
 */
export function clampLimit(value, fallback, ceiling = 250) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), ceiling);
}

/**
 * 读取必填字符串参数，缺失时抛出可读错误。
 * @param {object} args - 工具参数。
 * @param {string} key - 参数名。
 * @param {string} [hint] - 额外提示。
 * @returns {string} 去空白后的值。
 */
export function requireString(args, key, hint) {
  const value = args?.[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少必填参数 ${key}${hint ? `（${hint}）` : ''}。`);
  }
  return value.trim();
}

/**
 * 读取可选字符串参数。
 * @param {object} args - 工具参数。
 * @param {string} key - 参数名。
 * @returns {string|undefined} 去空白后的值。
 */
export function optionalString(args, key) {
  const value = args?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 把字符串数组归一化：去空白、去重、丢弃空值。
 * @param {unknown} value - 原始值。
 * @returns {string[]} 归一化数组。
 */
export function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
