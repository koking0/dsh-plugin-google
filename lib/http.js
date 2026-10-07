/**
 * 零依赖 HTTP/HTTPS 客户端。
 *
 * DSH 插件运行环境不保证存在可导入的 undici / axios，因此这里直接基于
 * `node:http`、`node:https` 与 `node:tls` 实现。除了常规请求，还实现了：
 *
 * - `HTTP CONNECT` 代理隧道：Google API 在部分网络环境下需要经代理访问，
 *   通过 `config.proxy` 或 `HTTPS_PROXY` 等环境变量指定；
 * - 可配置的 TLS 证书校验；
 * - 重定向跟随、超时、协作式取消（`AbortSignal`）。
 *
 * @module dsh-plugin-google/lib/http
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 传输层或 HTTP 状态层失败。 */
export class HttpError extends Error {
  /**
   * @param {string} message - 面向模型的可读说明。
   * @param {object} [details] - 诊断上下文（status/url/method/data/retryable）。
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'HttpError';
    Object.assign(this, details);
  }
}

/**
 * 归一化代理设置：接受 `http://host:port`、`host:port` 或完整 URL；
 * 未显式配置时回退到常见环境变量。
 *
 * @param {string|undefined} value - 配置值。
 * @returns {URL|undefined} 代理地址；无代理时为 undefined。
 */
export function normalizeProxy(value) {
  const raw = (value && String(value).trim())
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
    || '';
  if (!raw) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (!url.port) url.port = url.protocol === 'https:' ? '443' : '80';
    return url;
  } catch {
    return undefined;
  }
}

/** 把查询值序列化为 Google API 期望的形式。 */
function appendQuery(params, key, value) {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    for (const item of value) appendQuery(params, key, item);
    return;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    params.append(key, String(value));
    return;
  }
  params.append(key, String(value));
}

/**
 * 拼接查询串；跳过 undefined / null / 空字符串，数组展开为重复参数。
 * @param {object} query - 查询参数。
 * @returns {string} 查询串（不含 `?`）。
 */
export function buildQueryString(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) appendQuery(params, key, value);
  return params.toString();
}

/** 通过 CONNECT 在代理上打开一条到目标主机的隧道。 */
function connectViaProxy(proxy, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const options = {
      host: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${target.hostname}:${Number(target.port) || (target.protocol === 'https:' ? 443 : 80)}`,
      headers: { host: `${target.hostname}:${Number(target.port) || 443}` },
      // 代理本身若是 https，则由 https 模块发起请求。
      ...(proxy.protocol === 'https:' ? {} : {}),
    };
    if (proxy.username) {
      const user = decodeURIComponent(proxy.username);
      const pass = decodeURIComponent(proxy.password ?? '');
      options.headers['proxy-authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }
    const lib = proxy.protocol === 'https:' ? https : http;
    const req = lib.request(options);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new HttpError(`通过代理建立隧道超时（${timeoutMs}ms）：${proxy.host}`, { url: String(target), retryable: true }));
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) {
        resolve(socket);
        return;
      }
      socket.destroy();
      reject(new HttpError(`代理拒绝建立隧道（HTTP ${res.statusCode}）：${proxy.host}`, {
        status: res.statusCode,
        url: String(target),
        retryable: res.statusCode === 407,
      }));
    });
    req.on('error', (error) => {
      reject(error instanceof HttpError ? error : new HttpError(`通过代理连接失败：${error.message}`, {
        url: String(target),
        code: error.code,
        retryable: true,
      }));
    });
    req.end();
  });
}

/**
 * 建立到目标的连接：直连时返回 undefined（交给 http/https 模块默认处理），
 * 走代理时返回已完成（必要时已 TLS 包装）的 socket。
 */
async function openTunnel(proxy, target, { rejectUnauthorized, timeoutMs }) {
  const socket = await connectViaProxy(proxy, target, timeoutMs);
  if (target.protocol !== 'https:') return socket;
  const secure = tls.connect({
    socket,
    servername: target.hostname,
    rejectUnauthorized,
    host: target.hostname,
    port: Number(target.port) || 443,
  });
  try {
    await once(secure, 'secureConnect');
  } catch (error) {
    secure.destroy();
    throw new HttpError(`代理隧道内 TLS 握手失败：${error.message}`, {
      url: String(target),
      code: error.code,
      retryable: true,
    });
  }
  return secure;
}

/** 发出一次原始请求，不做重定向与解析。 */
async function rawRequest(method, url, options) {
  const { headers, body, rejectUnauthorized, timeoutMs, proxy, signal } = options;
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new HttpError(`无效的 URL：${url}`, { url, method });
  }
  const lib = target.protocol === 'http:' ? http : https;
  const requestOptions = {
    method,
    hostname: target.hostname,
    port: target.port || undefined,
    path: `${target.pathname}${target.search}`,
    headers,
  };
  // 仅 https 需要 TLS 选项。
  if (target.protocol === 'https:') requestOptions.rejectUnauthorized = rejectUnauthorized;

  // 回环地址永不经过代理：OAuth 本地回调与自建测试服务都走直连。
  const activeProxy = proxy && !LOOPBACK_HOSTS.has(target.hostname) ? proxy : undefined;
  if (activeProxy) {
    const socket = await openTunnel(activeProxy, target, { rejectUnauthorized, timeoutMs });
    const agent = new lib.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = (_opts, callback) => {
      if (typeof callback === 'function') callback(null, socket);
      return socket;
    };
    requestOptions.agent = agent;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = lib.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => finish(resolve, {
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
      res.on('error', (error) => finish(reject, new HttpError(`读取响应失败：${error.message}`, { url, method })));
    });

    const onAbort = () => {
      req.destroy(new HttpError(`调用已取消：${method} ${url}`, { url, method, aborted: true }));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req.setTimeout(timeoutMs, () => {
      req.destroy(new HttpError(`请求超时（${timeoutMs}ms）：${method} ${url}`, { url, method, retryable: true }));
    });
    req.on('error', (error) => {
      if (error instanceof HttpError) {
        finish(reject, error);
        return;
      }
      const hint = error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || error.code === 'SELF_SIGNED_CERT_IN_CHAIN'
        ? '（证书被拒绝：把 config.rejectUnauthorized 设为 false）'
        : (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT')
          ? '（网络不可达：如在中国大陆访问 Google，请在 config.proxy 中配置 HTTP 代理，或改用全局代理模式）'
          : '';
      finish(reject, new HttpError(`连接 ${target.hostname} 失败：${error.message}${hint}`, {
        url,
        method,
        code: error.code,
        retryable: true,
      }));
    });
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

/** 跟随重定向；303 与其他 301/302 的语义差异按 HTTP 规范处理。 */
async function send(method, url, options, redirects = 0) {
  const response = await rawRequest(method, url, options);
  const location = response.headers.location;
  if (REDIRECT_STATUS.has(response.status) && location && redirects < MAX_REDIRECTS) {
    const nextUrl = new URL(location, url).toString();
    const nextMethod = response.status === 303 ? 'GET' : method;
    const nextOptions = nextMethod === method ? options : { ...options, body: undefined };
    return send(nextMethod, nextUrl, nextOptions, redirects + 1);
  }
  return response;
}

/**
 * 创建 HTTP 客户端。
 *
 * @param {object} [options] - 连接参数。
 * @param {number} [options.timeoutMs] - 单次请求超时。
 * @param {boolean} [options.rejectUnauthorized] - 是否校验 TLS 证书。
 * @param {string} [options.proxy] - HTTP(S) 代理，形如 `http://127.0.0.1:7890`。
 * @param {object} [options.logger] - 可选日志器。
 * @returns {object} `{ request, get, post, patch, put, del, form }`
 */
export function createHttpClient({ timeoutMs = 30000, rejectUnauthorized = true, proxy, logger } = {}) {
  const proxyUrl = normalizeProxy(proxy);

  /** 统一入口：返回 { status, headers, buffer, text, json }。 */
  async function request(method, url, opts = {}) {
    const {
      query, headers = {}, body: rawBody, json, form, accept = 'application/json',
      timeoutMs: perCallTimeout, signal,
    } = opts;
    const queryString = buildQueryString(query);
    const fullUrl = queryString ? `${url}${url.includes('?') ? '&' : '?'}${queryString}` : url;
    const requestHeaders = { accept, ...headers };
    let payload;
    if (json !== undefined) {
      payload = Buffer.from(JSON.stringify(json), 'utf8');
      requestHeaders['content-type'] = 'application/json; charset=utf-8';
    } else if (form !== undefined) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(form)) {
        if (value === undefined || value === null) continue;
        params.append(key, String(value));
      }
      payload = Buffer.from(params.toString(), 'utf8');
      requestHeaders['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8';
    } else if (rawBody !== undefined) {
      payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    }
    if (payload !== undefined) requestHeaders['content-length'] = String(payload.byteLength);

    const response = await send(method, fullUrl, {
      headers: requestHeaders,
      body: payload,
      rejectUnauthorized,
      timeoutMs: perCallTimeout ?? timeoutMs,
      proxy: proxyUrl,
      signal,
    });

    const text = response.body.toString('utf8');
    let parsed;
    const contentType = String(response.headers['content-type'] ?? '');
    if (contentType.includes('json') && text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      buffer: response.body,
      text,
      json: parsed,
      ok: response.status >= 200 && response.status < 300,
    };
  }

  /**
   * 请求并要求成功；失败时抛出 {@link HttpError}，并尽可能给出 Google 的原始错误。
   * `describe` 用于把错误包装成面向模型的中文说明。
   */
  async function requestOrThrow(method, url, opts = {}) {
    const response = await request(method, url, opts);
    if (!response.ok) {
      throw new HttpError(describeFailure(response, method, url), {
        status: response.status,
        url,
        method,
        data: response.json,
      });
    }
    return response;
  }

  return {
    request,
    requestOrThrow,
    get: (url, opts) => requestOrThrow('GET', url, opts),
    post: (url, opts) => requestOrThrow('POST', url, opts),
    patch: (url, opts) => requestOrThrow('PATCH', url, opts),
    put: (url, opts) => requestOrThrow('PUT', url, opts),
    del: (url, opts) => requestOrThrow('DELETE', url, opts),
  };
}

/** 从 Google 错误响应中提取可读结论。 */
function describeFailure(response, method, url) {
  const data = response.json;
  const parts = [`HTTP ${response.status}`];
  if (data && typeof data === 'object') {
    const error = data.error;
    if (error && typeof error === 'object') {
      if (error.message) parts.push(String(error.message));
      if (error.status) parts.push(`[${error.status}]`);
      if (Array.isArray(error.errors) && error.errors.length > 0) {
        const reasons = error.errors.map((item) => item?.reason).filter(Boolean);
        if (reasons.length > 0) parts.push(`原因：${reasons.join(', ')}`);
      }
    } else if (typeof error === 'string') {
      parts.push(error);
      if (data.error_description) parts.push(String(data.error_description));
    } else if (data.message) {
      parts.push(String(data.message));
    }
  } else if (response.text) {
    parts.push(response.text.slice(0, 300));
  }
  if (response.status === 401 || response.status === 403) {
    parts.push('（如为授权失效，可运行 google_auth_status 检查，并用 google_auth_begin 重新授权）');
  }
  if (response.status === 429) parts.push('（触发配额或频率限制，请稍后重试）');
  return `${method} ${url} 失败：${parts.join(' ')}`;
}
