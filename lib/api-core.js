/**
 * Google API 调用核心：统一注入 Bearer 令牌、处理 401 重试与错误翻译。
 *
 * Calendar 与 Tasks 两个客户端都建立在这一层之上，避免重复实现鉴权与错误处理。
 *
 * @module dsh-plugin-google/lib/api-core
 */

import { HttpError } from './http.js';

/** 对路径片段做 URL 编码（`@me`、`primary` 等保留字按原样保留可读性）。 */
export function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

/**
 * 创建绑定到某个 API 基础地址的调用器。
 *
 * @param {object} options - 依赖。
 * @param {object} options.http - HTTP 客户端。
 * @param {object} options.auth - 授权模块。
 * @param {string} options.baseUrl - 形如 `https://www.googleapis.com/calendar/v3`。
 * @param {object} [options.logger] - 可选日志器。
 * @returns {(method:string, path:string, options?:object) => Promise<any>} 调用函数。
 */
export function createCaller({ http, auth, baseUrl, logger }) {
  /**
   * 调用一次 API。
   *
   * @param {string} method - HTTP 方法。
   * @param {string} path - 以 `/` 开头的路径。
   * @param {object} [options] - `{ query, body, signal, raw }`。
   * @returns {Promise<any>} 解析后的 JSON；`raw: true` 时返回完整响应。
   */
  async function call(method, path, options = {}) {
    const url = `${baseUrl}${path}`;
    const send = async (token) => http.request(method, url, {
      query: options.query,
      json: options.body,
      headers: { authorization: `Bearer ${token}` },
      signal: options.signal,
    });
    let token = await auth.getAccessToken();
    let response = await send(token);
    // access token 可能在服务端被提前失效（密码变更、会话过期），强制刷新后重试一次。
    if (response.status === 401) {
      logger?.debug?.('[google] 收到 401，强制刷新令牌后重试', { url });
      token = await auth.getAccessToken({ force: true });
      response = await send(token);
    }
    if (!response.ok) {
      throw new HttpError(describeGoogleFailure(response, method, url), {
        status: response.status,
        url,
        method,
        data: response.json,
      });
    }
    if (options.raw) return response;
    // DELETE 等操作返回 204，没有响应体。
    if (response.status === 204 || response.text.length === 0) return null;
    return response.json ?? null;
  }

  return call;
}

/** 把 Google 错误响应翻译成面向模型的中文说明。 */
export function describeGoogleFailure(response, method, url) {
  const data = response.json;
  const parts = [`HTTP ${response.status}`];
  const error = data?.error;
  if (error && typeof error === 'object') {
    if (error.message) parts.push(String(error.message));
    if (error.status && error.status !== String(response.status)) parts.push(`[${error.status}]`);
    const reasons = Array.isArray(error.errors) ? error.errors.map((item) => item?.reason).filter(Boolean) : [];
    if (reasons.length > 0) parts.push(`原因：${reasons.join(', ')}`);
  } else if (typeof error === 'string') {
    parts.push(error);
    if (data?.error_description) parts.push(String(data.error_description));
  } else if (response.text) {
    parts.push(response.text.slice(0, 300));
  }
  const hints = {
    400: '（请求参数不合法：请检查时间格式、日历 ID 与重复规则）',
    401: '（授权失效：运行 google_auth_status 检查，必要时重新授权）',
    403: '（无权限或超出配额：确认已启用对应的 Google API，且授权范围包含所需权限）',
    404: '（资源不存在：可能是 ID 错误，或该日历/任务列表已删除）',
    409: '（冲突：目标状态已存在）',
    410: '（资源已永久删除）',
    429: '（触发频率限制：请稍后重试）',
  };
  if (hints[response.status]) parts.push(hints[response.status]);
  return `${method} ${url} 失败：${parts.join(' ')}`;
}
