/**
 * 授权层测试：状态检查、两步式本地回调授权、手动授权码、重置与错误分支。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHarness } from './harness.mjs';

async function withHarness(options, fn) {
  const harness = await createHarness(options);
  try {
    await fn(harness);
  } finally {
    await harness.close();
  }
}

/** 模拟浏览器访问回调地址。 */
async function hitCallback(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url.toString());
  return { status: response.status, text: await response.text() };
}

test('google_auth_status 在未配置客户端且无令牌时给出下一步', async () => {
  await withHarness({ withToken: false, config: { clientId: undefined, clientSecret: undefined } }, async (h) => {
    const result = await h.call('google_auth_status', {});
    assert.match(result.text, /OAuth 客户端：未配置/);
    assert.match(result.text, /本地令牌：无/);
    assert.match(result.text, /桌面应用/);
    assert.equal(result.data.clientConfigured, false);
    assert.equal(result.data.hasToken, false);
  });
});

test('google_auth_status 在已有令牌时实时验证并显示账号信息', async () => {
  await withHarness({}, async (h) => {
    const result = await h.call('google_auth_status', {});
    assert.match(result.text, /OAuth 客户端：已配置/);
    assert.match(result.text, /实时验证：成功/);
    assert.equal(result.data.live.ok, true);
    assert.equal(result.data.hasRefreshToken, true);

    const skipped = await h.call('google_auth_status', { verify: false });
    assert.match(skipped.text, /OAuth 客户端：已配置/);
    assert.equal(skipped.data.live, null);
  });
});

test('完整的两步式本地回调授权流程', async () => {
  await withHarness({ withToken: false }, async (h) => {
    const begin = await h.call('google_auth_begin', { loginHint: 'me@example.com' });
    const { url, redirectUri, state } = begin.data;

    // 授权链接应当带上离线访问、强制同意与完整范围。
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('client_id'), h.config.clientId);
    assert.equal(parsed.searchParams.get('redirect_uri'), redirectUri);
    assert.equal(parsed.searchParams.get('response_type'), 'code');
    assert.equal(parsed.searchParams.get('access_type'), 'offline');
    assert.equal(parsed.searchParams.get('prompt'), 'consent');
    assert.equal(parsed.searchParams.get('state'), state);
    assert.equal(parsed.searchParams.get('login_hint'), 'me@example.com');
    assert.match(parsed.searchParams.get('scope'), /auth\/calendar/);
    assert.match(parsed.searchParams.get('scope'), /auth\/tasks/);
    assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);

    // 浏览器同意后，本地回调服务收到授权码。
    const callback = await hitCallback(redirectUri, { code: 'auth-code-1', state });
    assert.equal(callback.status, 200);
    assert.match(callback.text, /授权成功/);

    const done = await h.call('google_auth_complete', { waitMs: 2000 });
    assert.match(done.text, /Google 授权完成/);
    const token = await h.readToken();
    assert.equal(token.refresh_token, 'rt-1');
    assert.ok(token.access_token);

    // 授权后即可正常调用 API。
    const calendars = await h.call('gcal_list_calendars', {});
    assert.equal(calendars.data.total, 2);
  });
});

test('用户尚未点完授权时返回「仍在等待」，完成后可续接', async () => {
  await withHarness({ withToken: false }, async (h) => {
    const begin = await h.call('google_auth_begin', {});
    const pending = await h.call('google_auth_complete', { waitMs: 150 });
    assert.equal(pending.data.status, 'pending');
    assert.match(pending.text, /仍在等待/);
    assert.equal(pending.data.url, begin.data.url);

    await hitCallback(begin.data.redirectUri, { code: 'auth-code-2', state: begin.data.state });
    const done = await h.call('google_auth_complete', { waitMs: 2000 });
    assert.match(done.text, /Google 授权完成/);
    assert.equal((await h.readToken()).refresh_token, 'rt-1');
  });
});

test('state 不匹配的回调被拒绝，流程继续等待', async () => {
  await withHarness({ withToken: false }, async (h) => {
    const begin = await h.call('google_auth_begin', {});
    const bad = await hitCallback(begin.data.redirectUri, { code: 'x', state: 'forged-state' });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /授权校验失败/);

    const pending = await h.call('google_auth_complete', { waitMs: 150 });
    assert.equal(pending.data.status, 'pending');

    await hitCallback(begin.data.redirectUri, { code: 'auth-code-3', state: begin.data.state });
    const done = await h.call('google_auth_complete', { waitMs: 2000 });
    assert.match(done.text, /Google 授权完成/);
  });
});

test('用户拒绝授权时报出 error', async () => {
  await withHarness({ withToken: false }, async (h) => {
    const begin = await h.call('google_auth_begin', {});
    const denied = await hitCallback(begin.data.redirectUri, { error: 'access_denied', state: begin.data.state });
    assert.equal(denied.status, 200);
    assert.match(denied.text, /授权被拒绝/);

    await assert.rejects(
      () => h.call('google_auth_complete', { waitMs: 2000 }),
      /Google 授权失败：access_denied/,
    );
    // 失败后令牌文件不应存在。
    await assert.rejects(() => h.readToken());
  });
});

test('没有进行中的流程且未给 code 时报错', async () => {
  await withHarness({ withToken: false }, async (h) => {
    await assert.rejects(() => h.call('google_auth_complete', {}), /当前没有正在进行的授权流程/);
  });
});

test('支持手动传入 redirectUrl 完成授权', async () => {
  await withHarness({ withToken: false }, async (h) => {
    const begin = await h.call('google_auth_begin', {});
    const redirectUrl = `${begin.data.redirectUri}?code=manual-code&state=${begin.data.state}`;
    const done = await h.call('google_auth_complete', { redirectUrl });
    assert.match(done.text, /Google 授权完成/);
    assert.equal((await h.readToken()).refresh_token, 'rt-1');
  });
});

test('手动传入非法 redirectUrl 时给出参数错误', async () => {
  await withHarness({ withToken: false }, async (h) => {
    await assert.rejects(() => h.call('google_auth_complete', { redirectUrl: 'not a url' }), /不是合法 URL/);
  });
});

test('google_auth_reset 需要确认，并按 revoke 决定是否撤销', async () => {
  await withHarness({}, async (h) => {
    await assert.rejects(() => h.call('google_auth_reset', {}), /需要二次确认/);

    // 先做一次不撤销的重置。
    const cleared = await h.call('google_auth_reset', { confirm: true });
    assert.equal(cleared.data.removed, true);
    await assert.rejects(() => h.readToken());

    // 重新授权后再做带撤销的重置。
    await h.auth.saveToken({ refresh_token: 'rt-seed' });
    const revoked = await h.call('google_auth_reset', { confirm: true, revoke: true });
    assert.equal(revoked.data.revoked, true);
    assert.equal(h.mock.state.validRefreshTokens.has('rt-seed'), false);
    await assert.rejects(() => h.readToken());
  });
});

test('未配置客户端时无法生成授权链接也无法换取令牌', async () => {
  await withHarness({ withToken: false, config: { clientId: undefined, clientSecret: undefined } }, async (h) => {
    await assert.rejects(() => h.call('google_auth_begin', {}), /尚未配置 OAuth 客户端凭据/);
  });
});

test('从 clientSecretFile 读取桌面应用凭据', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-google-client-'));
  const file = join(dir, 'client.json');
  await writeFile(file, JSON.stringify({
    installed: { client_id: 'file-client-id.apps.googleusercontent.com', client_secret: 'file-secret' },
  }), 'utf8');
  try {
    const harness = await createHarness({
      withToken: false,
      config: { clientId: undefined, clientSecret: undefined, clientSecretFile: file },
    });
    try {
      const status = await harness.call('google_auth_status', {});
      assert.match(status.text, /已配置/);
      assert.match(String(status.data.clientSource), /clientSecretFile/);
      assert.equal(status.data.clientIdMasked.startsWith('file-cli'), true);

      const begin = await harness.call('google_auth_begin', {});
      assert.match(new URL(begin.data.url).searchParams.get('client_id'), /^file-client-id/);
    } finally {
      await harness.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
