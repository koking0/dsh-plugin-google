/**
 * 一次性授权助手（浏览器/终端里跑，不经过对话）。
 *
 * 用途：当不方便通过对话触发 `google_auth_begin` / `google_auth_complete` 时，
 * 在命令行完成同一套回环 OAuth 授权。它直接复用插件自己的模块
 * （`lib/auth.js` + `lib/oauth-flow.js` + `lib/http.js`），因此与插件走的是
 * 完全相同的代码路径，不存在第二套实现。
 *
 * 用法：
 *   node scripts/authorize.mjs
 *   node scripts/authorize.mjs --port 47821 --client-file <path> --token-file <path>
 *
 * @module dsh-plugin-google/scripts/authorize
 */

import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createAuth, DEFAULT_ENDPOINTS, DEFAULT_SCOPES } from '../lib/auth.js';
import { createHttpClient } from '../lib/http.js';
import { createConsentFlow } from '../lib/oauth-flow.js';

/** 解析 `--key value` 形式的命令行参数。 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');

const config = {
  clientSecretFile: args['client-file'] ?? join(dshHome, 'google-oauth-client.json'),
  tokenFile: args['token-file'] ?? join(dshHome, 'google-oauth-token.json'),
  oauthRedirectPort: Number(args.port ?? 47821),
  oauthCallbackPath: '/oauth2callback',
  oauthFlowTimeoutMs: Number(args['timeout-ms'] ?? 600_000),
  timeZone: 'Asia/Shanghai',
  scopes: DEFAULT_SCOPES,
  oauthAuthUrl: DEFAULT_ENDPOINTS.authUrl,
  oauthTokenUrl: DEFAULT_ENDPOINTS.tokenUrl,
  oauthRevokeUrl: DEFAULT_ENDPOINTS.revokeUrl,
  requestTimeoutMs: 30_000,
  proxy: args.proxy,
};

const http = createHttpClient({ timeoutMs: config.requestTimeoutMs, proxy: config.proxy });
const auth = createAuth({ config, http, logger: console });
const flow = createConsentFlow({ auth, config, logger: console });

/** 把授权链接既打印出来、也写一份到文件，方便外部读取。 */
function publishUrl(url) {
  console.log('\n=== 请在浏览器中打开下面的授权链接 ===\n');
  console.log(url);
  console.log('');
  const urlFile = args['url-file'];
  if (urlFile) writeFileSync(urlFile, url, 'utf8');
}

const started = await flow.begin({ port: config.oauthRedirectPort });
publishUrl(started.url);
console.log(`回调地址：${started.redirectUri}`);
console.log('等待浏览器完成授权……\n');

const outcome = await flow.waitForCode({ timeoutMs: config.oauthFlowTimeoutMs, consume: true });
if (outcome.status !== 'ok') {
  console.error(`授权未完成：${outcome.status} ${outcome.error ?? outcome.reason ?? ''}`);
  process.exit(1);
}

const token = await auth.exchangeCode({ code: outcome.code, redirectUri: started.redirectUri });
let email;
try {
  const primary = await http.get(`${DEFAULT_ENDPOINTS.calendarApiBase}/calendars/primary`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  email = primary.json?.id;
} catch (error) {
  console.error(`（已拿到令牌，但读取主日历失败：${error.message}）`);
}
if (email) await auth.saveToken({ email });

console.log('授权完成！');
console.log(`  账号：${email ?? '(未取到邮箱)'}`);
console.log(`  授权范围：${token.scope ?? '(未返回)'}`);
console.log(`  令牌文件：${config.tokenFile}`);

// 顺手做一次真实调用，确认 API 已启用、令牌可用。
try {
  const list = await http.get(`${DEFAULT_ENDPOINTS.calendarApiBase}/users/me/calendarList`, {
    query: { maxResults: 10 },
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  const items = list.json?.items ?? [];
  console.log(`  验证：成功读到 ${items.length} 个日历 —— ${items.map((item) => item.summary).join('、')}`);
} catch (error) {
  console.error(`  验证失败：${error.message}`);
  process.exit(1);
}

process.exit(0);
