/**
 * OAuth 授权码模式的本地回调流程。
 *
 * 「桌面应用」类型的 OAuth 客户端允许把任意端口的 `http://127.0.0.1:PORT` 作为重定向地址，
 * 因此插件可以在本机临时起一个 HTTP 服务接收授权码，浏览器授权后自动完成交换，
 * 用户只需要在对话里点开一个链接。
 *
 * 为了让工具调用快速返回，回调结果由后台监听器捕获：
 * `waitForCode()` 只在给定时间内等待，超时返回「仍在等待」而不是报错，
 * 用户完成授权后再次调用即可立刻拿到结果。
 *
 * @module dsh-plugin-google/lib/oauth-flow
 */

import http from 'node:http';

import { AuthError, randomToken } from './auth.js';

const DEFAULT_CALLBACK_PATH = '/oauth2callback';
const DEFAULT_WAIT_MS = 20_000;

/** HTML 转义，避免把用户输入回显进页面。 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 授权成功/失败时展示给用户的页面。 */
function resultPage({ ok, title, detail }) {
  const color = ok ? '#0a7d33' : '#b42318';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
 body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;
      display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f6f7f9;color:#1f2328}
 main{background:#fff;border-radius:14px;padding:32px 36px;box-shadow:0 8px 30px rgba(0,0,0,.08);max-width:520px}
 h1{font-size:20px;color:${color};margin:0 0 12px}
 p{margin:8px 0;line-height:1.7;color:#404752}
 code{background:#f0f1f3;border-radius:6px;padding:2px 6px}
</style></head>
<body><main>
<h1>${escapeHtml(title)}</h1>
<p>${detail}</p>
<p>可以关闭本页面，回到 DeepSeek Harness 继续对话。</p>
</main></body></html>`;
}

/**
 * 创建本地授权流程管理器。
 *
 * @param {object} options - 依赖。
 * @param {object} options.auth - {@link createAuth} 返回的授权模块。
 * @param {object} options.config - 插件配置。
 * @param {object} [options.logger] - 可选日志器。
 * @param {() => number} [options.now] - 时钟。
 * @returns {object} 流程 API。
 */
export function createConsentFlow({ auth, config, logger, now = () => Date.now() }) {
  /** 当前挂起的流程。 */
  let pending = null;

  /** 关闭并清理挂起流程。 */
  function teardown(reason) {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    try {
      current.server.close();
      current.server.closeAllConnections?.();
    } catch {
      // 关闭失败不影响调用方。
    }
    current.settle({ status: 'cancelled', reason });
  }

  /**
   * 启动回调监听并生成授权链接。
   *
   * @param {object} [options] - 覆盖项。
   * @param {number} [options.port] - 监听端口，0 表示由系统分配。
   * @param {string} [options.callbackPath] - 回调路径。
   * @param {number} [options.timeoutMs] - 链接有效期。
   * @param {string} [options.loginHint] - 预填邮箱。
   * @param {boolean} [options.forceConsent] - 是否强制重新同意（确保拿到 refresh_token）。
   * @returns {Promise<object>} `{ url, redirectUri, expiresAt }`。
   */
  async function begin(options = {}) {
    teardown('restarted');

    const configuredRedirect = config.oauthRedirectUri ? String(config.oauthRedirectUri) : undefined;
    let listenPort = Number.isFinite(options.port) && options.port > 0 ? Number(options.port) : (Number(config.oauthRedirectPort) || 0);
    let callbackPath = options.callbackPath || config.oauthCallbackPath || DEFAULT_CALLBACK_PATH;
    let listenHost = '127.0.0.1';
    if (configuredRedirect) {
      try {
        const parsed = new URL(configuredRedirect);
        listenHost = parsed.hostname;
        listenPort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
        callbackPath = parsed.pathname || callbackPath;
      } catch {
        throw new AuthError(`config.oauthRedirectUri 不是合法 URL：${configuredRedirect}`, { code: 'BAD_REDIRECT' });
      }
      if (listenHost === 'localhost') listenHost = '127.0.0.1';
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : (Number(config.oauthFlowTimeoutMs) || 900_000);
    const state = randomToken(16);

    let settle;
    const outcome = new Promise((resolve) => { settle = resolve; });
    const entry = {
      state,
      settle,
      outcome,
      server: null,
      timer: null,
      createdAt: now(),
      expiresAt: now() + timeoutMs,
      redirectUri: undefined,
      resolved: false,
    };
    pending = entry;

    const server = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url, `http://127.0.0.1:${entry.redirectUri ? new URL(entry.redirectUri).port : listenPort}`);
      } catch {
        res.writeHead(400).end('Bad Request');
        return;
      }
      if (url.pathname !== callbackPath) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      if (returnedState !== state) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(resultPage({
          ok: false,
          title: '授权校验失败',
          detail: '回调中的 state 与本次请求不一致，已忽略该回调。请重新发起授权。',
        }));
        return;
      }
      if (error) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(resultPage({
          ok: false,
          title: '授权被拒绝',
          detail: `Google 返回：<code>${escapeHtml(error)}</code>`,
        }));
        entry.resolved = true;
        settle({ status: 'error', error: `Google 授权失败：${error}`, reason: error });
        return;
      }
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(resultPage({
          ok: false,
          title: '缺少授权码',
          detail: '回调地址中没有 <code>code</code> 参数。',
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(resultPage({
        ok: true,
        title: '授权成功',
        detail: '已收到 Google 的授权码，正在写入本地凭据。',
      }));
      entry.resolved = true;
      settle({ status: 'ok', code });
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        if (error?.code === 'EADDRINUSE') {
          reject(new AuthError(
            `本地回调端口 ${listenPort} 已被占用。请关闭占用该端口的程序，或把 config.oauthRedirectPort 设为 0（自动分配）。`,
            { code: 'EADDRINUSE', port: listenPort },
          ));
          return;
        }
        reject(new AuthError(`无法启动本地回调服务：${error.message}`, { code: error?.code }));
      };
      server.once('error', onError);
      server.listen(listenPort, listenHost, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
    entry.server = server;

    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : listenPort;
    entry.redirectUri = configuredRedirect || `http://${listenHost}:${actualPort}${callbackPath}`;
    entry.timer = setTimeout(() => teardown('timeout'), timeoutMs);
    entry.timer.unref?.();

    const built = await auth.buildAuthorizeUrl({
      redirectUri: entry.redirectUri,
      state,
      loginHint: options.loginHint,
      forceConsent: options.forceConsent !== false,
    });

    logger?.info?.('[google] 已启动本地授权回调', { redirectUri: entry.redirectUri, expiresAt: entry.expiresAt });
    entry.url = built.url;
    return {
      url: built.url,
      redirectUri: entry.redirectUri,
      state,
      expiresAt: entry.expiresAt,
      timeoutMs,
      clientIdMasked: built.client.clientId.slice(0, 8),
    };
  }

  /**
   * 等待回调结果。
   *
   * @param {object} [options] - `{ timeoutMs }` 本次等待上限；`{ consume }` 是否在成功后结束流程。
   * @returns {Promise<object>} `{ status: 'ok'|'error'|'pending'|'cancelled'|'idle', code?, error? }`。
   */
  async function waitForCode(options = {}) {
    if (!pending) return { status: 'idle', reason: '没有正在进行的授权流程' };
    const entry = pending;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : DEFAULT_WAIT_MS;
    const result = await Promise.race([
      entry.outcome,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ status: 'pending' }), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (result.status === 'ok') {
      if (options.consume !== false) teardown('consumed');
      return result;
    }
    if (result.status === 'pending') return { status: 'pending', redirectUri: entry.redirectUri, url: entry.url };
    return result;
  }

  /** 查询挂起状态。 */
  function status() {
    if (!pending) return { active: false };
    return {
      active: true,
      url: pending.url,
      redirectUri: pending.redirectUri,
      expiresAt: pending.expiresAt,
      resolved: pending.resolved,
      secondsLeft: Math.max(0, Math.round((pending.expiresAt - now()) / 1000)),
    };
  }

  /** 主动取消。 */
  function cancel() {
    teardown('cancelled');
    return { cancelled: true };
  }

  return { begin, waitForCode, status, cancel };
}
