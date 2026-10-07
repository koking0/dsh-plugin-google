/**
 * Google OAuth 2.0 授权层。
 *
 * 只实现「已安装应用 / 桌面应用」所需的授权码模式：一次性拿到 refresh token，
 * 之后由 `getAccessToken()` 自动换取并缓存 access token。全程零第三方依赖。
 *
 * 客户端凭据（client_id / client_secret）按以下顺序解析：
 * 1. `config.clientId` / `config.clientSecret`；
 * 2. `config.clientSecretFile`（Google Cloud 控制台下载的 JSON，支持 `installed` / `web` /
 *    平铺三种结构）；
 * 3. DSH 凭据服务（`config.credentialRef`），值可以是客户端 JSON 或 `id:secret`；
 * 4. 环境变量 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`。
 *
 * @module dsh-plugin-google/lib/auth
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Google 默认端点；全部可通过配置覆盖，便于自建代理与测试。 */
export const DEFAULT_ENDPOINTS = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  calendarApiBase: 'https://www.googleapis.com/calendar/v3',
  tasksApiBase: 'https://tasks.googleapis.com/tasks/v1',
};

/** 默认申请的权限范围：日历读写 + 任务读写。 */
export const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
];

/** 授权相关失败。 */
export class AuthError extends Error {
  /**
   * @param {string} message - 面向模型的中文说明。
   * @param {object} [details] - 诊断上下文。
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'AuthError';
    Object.assign(this, details);
  }
}

/** 生成 URL 安全的随机串。 */
export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * 从 Google 客户端 JSON 中抽取 client_id / client_secret，兼容三种结构。
 * @param {any} parsed - 已解析的 JSON。
 * @returns {{clientId:string, clientSecret:string}|undefined} 凭据。
 */
export function extractClientFromJson(parsed) {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const nested = parsed.installed ?? parsed.web ?? parsed.desktop ?? parsed;
  const clientId = nested.client_id ?? nested.clientId;
  const clientSecret = nested.client_secret ?? nested.clientSecret;
  if (!clientId || !clientSecret) return undefined;
  return { clientId: String(clientId), clientSecret: String(clientSecret) };
}

/** 解析 `id:secret` 形式的凭据字符串。 */
function extractClientFromPair(text) {
  const match = /^\s*([^:\s]+)\s*:\s*(\S+)\s*$/.exec(text);
  if (!match) return undefined;
  return { clientId: match[1], clientSecret: match[2] };
}

/** 原子写入，尽量收紧文件权限。 */
async function writePrivateFile(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

/**
 * 创建授权模块。
 *
 * @param {object} options - 依赖与配置。
 * @param {object} options.config - 已校验的插件配置。
 * @param {object} options.http - {@link createHttpClient} 返回的客户端。
 * @param {object} [options.logger] - 可选日志器。
 * @param {() => number} [options.now] - 时钟，便于测试。
 * @param {object} [options.credentials] - DSH 凭据服务（`ctx.get('credentials')`）。
 * @returns {object} 授权 API。
 */
export function createAuth({ config, http, logger, now = () => Date.now(), credentials = undefined }) {
  const endpoints = {
    authUrl: config.oauthAuthUrl || DEFAULT_ENDPOINTS.authUrl,
    tokenUrl: config.oauthTokenUrl || DEFAULT_ENDPOINTS.tokenUrl,
    revokeUrl: config.oauthRevokeUrl || DEFAULT_ENDPOINTS.revokeUrl,
  };
  const scopes = Array.isArray(config.scopes) && config.scopes.length > 0 ? config.scopes : DEFAULT_SCOPES;
  /** 进程内 access token 缓存。 */
  let cachedAccess = null;

  /** 解析客户端凭据。 */
  async function resolveClient() {
    if (config.clientId && config.clientSecret) {
      return { clientId: config.clientId, clientSecret: config.clientSecret, source: 'config.clientId/clientSecret' };
    }
    if (config.clientSecretFile) {
      try {
        const text = await readFile(config.clientSecretFile, 'utf8');
        const client = extractClientFromJson(JSON.parse(text));
        if (client) return { ...client, source: `clientSecretFile(${config.clientSecretFile})` };
        logger?.debug?.('[google] clientSecretFile 中未找到 client_id/client_secret', { path: config.clientSecretFile });
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          logger?.debug?.('[google] 读取 clientSecretFile 失败', { path: config.clientSecretFile, message: error?.message });
        }
      }
    }
    if (credentials && config.credentialRef) {
      try {
        const resolved = await credentials.resolve(config.credentialRef);
        const value = resolved?.value;
        if (value) {
          const fromJson = extractClientFromJson(safeJson(value));
          if (fromJson) return { ...fromJson, source: `credentials(${config.credentialRef})` };
          const pair = extractClientFromPair(value);
          if (pair) return { ...pair, source: `credentials(${config.credentialRef})` };
        }
      } catch (error) {
        logger?.debug?.('[google] 凭据服务解析失败', { ref: config.credentialRef, message: error?.message });
      }
    }
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      return {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        source: '环境变量 GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET',
      };
    }
    return undefined;
  }

  /** 读取已保存的令牌。 */
  async function loadToken() {
    if (!config.tokenFile) return null;
    try {
      const parsed = JSON.parse(await readFile(config.tokenFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.debug?.('[google] 读取 tokenFile 失败', { path: config.tokenFile, message: error?.message });
      }
      return null;
    }
  }

  /** 保存令牌（合并已有字段，避免丢失 refresh_token）。 */
  async function saveToken(patch) {
    if (!config.tokenFile) throw new AuthError('未配置 tokenFile，无法保存授权结果。');
    const previous = (await loadToken()) ?? {};
    const merged = { ...previous, ...patch, updatedAt: new Date(now()).toISOString() };
    await writePrivateFile(config.tokenFile, `${JSON.stringify(merged, null, 2)}\n`);
    cachedAccess = null;
    return merged;
  }

  /** 删除本地令牌（不撤销服务端授权）。 */
  async function clearToken() {
    cachedAccess = null;
    if (!config.tokenFile) return false;
    try {
      await unlink(config.tokenFile);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new AuthError(`删除令牌文件失败：${error.message}`, { path: config.tokenFile });
    }
  }

  /**
   * 取得可用的 access token；必要时用 refresh token 刷新。
   * @param {object} [options] - `{ force }` 强制刷新。
   * @returns {Promise<string>} Bearer 令牌。
   */
  async function getAccessToken({ force = false } = {}) {
    const token = await loadToken();
    if (!token) {
      throw new AuthError(
        '尚未完成 Google 授权。请先运行 google_auth_begin 获取授权链接，在浏览器同意后用 google_auth_complete 完成。',
        { code: 'NO_TOKEN' },
      );
    }
    const skewMs = 60_000;
    const hasCached = cachedAccess && cachedAccess.refreshToken === token.refresh_token;
    if (!force && hasCached && cachedAccess.expiresAt - skewMs > now()) return cachedAccess.value;
    if (!force && token.access_token && Number(token.expires_at ?? 0) - skewMs > now()) {
      cachedAccess = { value: token.access_token, expiresAt: Number(token.expires_at), refreshToken: token.refresh_token };
      return token.access_token;
    }
    if (!token.refresh_token) {
      throw new AuthError(
        '本地令牌缺少 refresh_token，无法自动续期。请重新运行 google_auth_begin / google_auth_complete 完成授权。',
        { code: 'NO_REFRESH_TOKEN' },
      );
    }
    const client = await resolveClientWithToken(token);
    const refreshed = await requestToken({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    const merged = await saveToken({
      access_token: refreshed.access_token,
      expires_at: now() + (Number(refreshed.expires_in ?? 3600) * 1000),
      scope: refreshed.scope ?? token.scope,
      token_type: refreshed.token_type ?? token.token_type ?? 'Bearer',
      // 刷新响应通常不再返回 refresh_token，保留原值。
      refresh_token: refreshed.refresh_token ?? token.refresh_token,
      clientId: client.clientId,
    });
    cachedAccess = {
      value: merged.access_token,
      expiresAt: Number(merged.expires_at),
      refreshToken: merged.refresh_token,
    };
    return merged.access_token;
  }

  /** 刷新时优先复用令牌文件里记录的 client_id，避免配置漂移导致 invalid_client。 */
  async function resolveClientWithToken(token) {
    const client = await resolveClient();
    if (client) return client;
    if (token.clientId && token.client_secret) {
      return { clientId: token.clientId, clientSecret: token.client_secret, source: 'tokenFile' };
    }
    if (token.clientId && config.clientSecret) {
      return { clientId: token.clientId, clientSecret: config.clientSecret, source: 'tokenFile+config' };
    }
    throw new AuthError(
      '找不到 OAuth 客户端凭据。请配置 config.clientSecretFile 指向 Google Cloud 下载的客户端 JSON，'
      + '或设置 config.clientId / config.clientSecret（也可用环境变量 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）。',
      { code: 'NO_CLIENT' },
    );
  }

  /** 调用令牌端点。 */
  async function requestToken(form) {
    const response = await http.request('POST', endpoints.tokenUrl, { form });
    if (!response.ok) {
      const data = response.json ?? {};
      const code = data.error ?? `http_${response.status}`;
      const hint = code === 'invalid_grant'
        ? '（refresh token 已失效：可能是被撤销、密码变更，或 OAuth 应用处于「测试」状态导致 7 天后过期；重新授权即可）'
        : code === 'invalid_client'
          ? '（客户端凭据不匹配：请确认 clientSecretFile 与该 refresh token 属于同一个 OAuth 客户端）'
          : '';
      throw new AuthError(`Google 令牌请求失败：${code} ${data.error_description ?? ''} ${hint}`.trim(), {
        status: response.status,
        code,
        data,
      });
    }
    return response.json ?? {};
  }

  /**
   * 用授权码换取令牌并落盘。
   * @param {object} params - `{ code, redirectUri }`。
   * @returns {Promise<object>} 保存后的令牌。
   */
  async function exchangeCode({ code, redirectUri }) {
    const client = await resolveClient();
    if (!client) {
      throw new AuthError(
        '尚未配置 OAuth 客户端凭据。请在 Google Cloud 控制台创建「桌面应用」OAuth 客户端，'
        + '下载 JSON 后放到 config.clientSecretFile 指定的位置。',
        { code: 'NO_CLIENT' },
      );
    }
    const tokenResponse = await requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    if (!tokenResponse.refresh_token) {
      throw new AuthError(
        'Google 未返回 refresh_token。通常是此前已授权过同一客户端：请到 '
        + 'https://myaccount.google.com/permissions 撤销访问后重试，或让授权链接带上 prompt=consent。',
        { code: 'NO_REFRESH_TOKEN' },
      );
    }
    return saveToken({
      access_token: tokenResponse.access_token,
      expires_at: now() + (Number(tokenResponse.expires_in ?? 3600) * 1000),
      refresh_token: tokenResponse.refresh_token,
      scope: tokenResponse.scope,
      token_type: tokenResponse.token_type ?? 'Bearer',
      clientId: client.clientId,
      client_secret: client.clientSecret,
    });
  }

  /** 撤销服务端授权并删除本地令牌。 */
  async function revoke() {
    const token = await loadToken();
    if (!token) return { revoked: false, reason: 'no-token' };
    const target = token.refresh_token ?? token.access_token;
    const response = await http.request('POST', endpoints.revokeUrl, { form: { token: target } });
    await clearToken();
    if (!response.ok && response.status !== 400) {
      return { revoked: false, reason: `HTTP ${response.status}` };
    }
    return { revoked: true };
  }

  /** 生成完整授权链接（缺失客户端凭据时抛出可读错误）。 */
  async function buildAuthorizeUrl({ redirectUri, state, loginHint, forceConsent = true }) {
    const client = await resolveClient();
    if (!client) {
      throw new AuthError(
        '尚未配置 OAuth 客户端凭据，无法生成授权链接。请在 Google Cloud 控制台创建'
        + '「桌面应用」类型的 OAuth 客户端，启用 Google Calendar API 与 Google Tasks API，'
        + '下载客户端 JSON 后放到 config.clientSecretFile 指定的路径。',
        { code: 'NO_CLIENT' },
      );
    }
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      state,
      include_granted_scopes: 'true',
    });
    if (forceConsent) params.set('prompt', 'consent');
    if (loginHint) params.set('login_hint', loginHint);
    return { url: `${endpoints.authUrl}?${params.toString()}`, client };
  }

  /** 汇总当前授权状态，供 `google_auth_status` 使用。 */
  async function describeStatus() {
    const client = await resolveClient();
    const token = await loadToken();
    return {
      clientConfigured: Boolean(client),
      clientSource: client?.source,
      clientIdMasked: client ? mask(client.clientId) : undefined,
      hasToken: Boolean(token?.refresh_token ?? token?.access_token),
      hasRefreshToken: Boolean(token?.refresh_token),
      expiresAt: token?.expires_at ? Number(token.expires_at) : undefined,
      scope: token?.scope,
      email: token?.email,
      tokenFile: config.tokenFile,
      scopes: scopes,
    };
  }

  return {
    endpoints,
    scopes,
    resolveClient,
    loadToken,
    saveToken,
    clearToken,
    getAccessToken,
    exchangeCode,
    requestToken,
    revoke,
    buildAuthorizeUrl,
    describeStatus,
  };
}

/** 掩码显示敏感 ID。 */
export function mask(value) {
  const text = String(value ?? '');
  if (text.length <= 12) return `${text.slice(0, 3)}***`;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

/** 宽松 JSON 解析。 */
function safeJson(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return undefined;
  }
}
