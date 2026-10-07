/**
 * 写入策略守卫：只读模式与二次确认。
 *
 * 与 OpenProject 插件保持一致的两条约定：
 * - `config.readOnly` 为 true 时，所有写入类工具直接拒绝；
 * - 删除类操作必须显式传 `confirm: true`，避免模型在用户未确认时误删。
 *
 * @module dsh-plugin-google/lib/guard
 */

import { ToolPolicyError } from './errors.js';

/**
 * 创建守卫。
 *
 * @param {object} options - 配置来源。
 * @param {object} options.config - 插件配置。
 * @returns {object} 守卫 API。
 */
export function createGuard({ config }) {
  const readOnly = config.readOnly === true;
  const requireConfirmForWrites = config.requireConfirmForWrites === true;

  /**
   * 断言当前允许写入。
   * @param {string} action - 操作名，用于错误信息。
   */
  function assertWritable(action) {
    if (readOnly) {
      throw new ToolPolicyError(
        `当前为只读模式（config.readOnly = true），已拒绝「${action}」。`
        + '如需写入，请把插件配置中的 readOnly 改为 false。',
        { code: 'READ_ONLY' },
      );
    }
  }

  /**
   * 校验二次确认。
   *
   * @param {object} args - 工具参数。
   * @param {object} options - `{ action, always }`；`always` 表示该操作始终需要确认。
   * @returns {boolean} 是否需要确认且已确认。
   */
  function confirm(args, { action, always = false }) {
    const needed = always || requireConfirmForWrites;
    if (!needed) return true;
    if (args?.confirm === true) return true;
    throw new ToolPolicyError(
      `「${action}」属于高风险操作，需要二次确认。`
      + '请先向用户说明将要执行的操作并取得同意，然后带上 confirm: true 重新调用；'
      + '若用户明确拒绝，请不要调用该工具。',
      { code: 'CONFIRM_REQUIRED' },
    );
  }

  return {
    readOnly,
    requireConfirmForWrites,
    assertWritable,
    confirm,

    /**
     * 普通写入工具的统一前置检查：只读模式与（可选的）写入确认。
     *
     * 默认 `config.requireConfirmForWrites = false`，此时等同于只做只读检查；
     * 打开该配置后，所有写入都会要求 `confirm: true`。
     *
     * @param {object} args - 工具参数。
     * @param {string} action - 操作名。
     */
    assertWrite(args, action) {
      assertWritable(action);
      confirm(args, { action });
    },
  };
}
