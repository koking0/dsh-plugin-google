/**
 * 插件内的错误类型。
 *
 * 单独成文件是为了让 `guard`、工具层与 API 层共享同一组错误，而不引入循环依赖。
 *
 * @module dsh-plugin-google/lib/errors
 */

/** 策略层拒绝（只读、缺少确认等）。 */
export class ToolPolicyError extends Error {
  /**
   * @param {string} message - 面向模型的中文说明。
   * @param {object} [details] - 诊断上下文。
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'ToolPolicyError';
    Object.assign(this, details);
  }
}

/**
 * 工具层参数错误：由模型修正后重试即可。
 */
export class ToolInputError extends Error {
  /**
   * @param {string} message - 面向模型的中文说明。
   * @param {object} [details] - 诊断上下文。
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'ToolInputError';
    Object.assign(this, details);
  }
}
