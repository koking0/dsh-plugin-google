/**
 * Google 授权相关工具：状态检查、发起授权、完成授权、重置凭据。
 *
 * 设计为「两步授权」：`google_auth_begin` 立刻返回授权链接（不阻塞对话），
 * 用户在浏览器同意后，本地回调服务在后台捕获授权码；再用 `google_auth_complete`
 * 取回并换取长期令牌。如果用户完成得很快，`google_auth_complete` 会在一次调用内直接成功。
 *
 * @module dsh-plugin-google/lib/tools/auth
 */

import { AuthError } from '../auth.js';
import { ToolInputError } from '../errors.js';
import {
  boolParam,
  CONFIRM_PARAM,
  intParam,
  optionalString,
  stringParam,
  toolSpec,
} from './common.js';

/**
 * 创建授权工具。
 *
 * @param {object} deps - 插件依赖。
 * @returns {object[]} 工具规格数组。
 */
export function createAuthTools(deps) {
  const { auth, flow, calendar, config, guard, logger } = deps;

  /** 尝试读取账号邮箱（主日历 ID 即邮箱）。失败不影响主流程。 */
  async function fetchAccountEmail() {
    try {
      const primary = await calendar.getCalendar('primary');
      return primary?.id && primary.id.includes('@') ? primary.id : undefined;
    } catch (error) {
      logger?.debug?.('[google] 读取主日历失败（不影响授权）', { message: error?.message });
      return undefined;
    }
  }

  /** 完成令牌交换并把账号邮箱写入令牌文件。 */
  async function finishAuthorization(code, redirectUri) {
    const token = await auth.exchangeCode({ code, redirectUri });
    const email = await fetchAccountEmail();
    if (email) await auth.saveToken({ email });
    return { email, scope: token.scope };
  }

  return [
    toolSpec({
      name: 'google_auth_status',
      title: '检查 Google 授权状态',
      kind: 'read',
      description: '检查 Google 日历/任务的授权状态：是否已配置 OAuth 客户端、是否已保存令牌、'
        + '授权范围、令牌到期时间与账号邮箱。默认会真实调用一次 Google API 验证令牌是否仍然有效，'
        + '因此这也是排查「突然不能用了」的第一手段。',
      parameters: {
        verify: boolParam('是否实际调用 Google API 验证令牌有效（默认 true）。网络受限时可传 false 只看本地状态。'),
      },
      async run(args) {
        const status = await auth.describeStatus();
        const lines = [];
        lines.push(`OAuth 客户端：${status.clientConfigured ? `已配置（来源：${status.clientSource}，client_id：${status.clientIdMasked}）` : '未配置'}`);
        lines.push(`本地令牌：${status.hasToken ? `已保存（${status.tokenFile}）` : '无'}`);
        if (status.hasToken) {
          lines.push(`refresh_token：${status.hasRefreshToken ? '有（可长期自动续期）' : '缺失（需要重新授权）'}`);
          if (status.expiresAt) {
            const left = Math.round((status.expiresAt - Date.now()) / 1000);
            lines.push(`access_token：${left > 0 ? `${left} 秒后过期（可自动刷新）` : '已过期（下次调用自动刷新）'}`);
          }
          if (status.email) lines.push(`账号：${status.email}`);
          if (status.scope) lines.push(`授权范围：${status.scope}`);
        }
        lines.push(`本次请求的范围：${status.scopes.join(' ')}`);

        let live = null;
        if (status.hasToken && args?.verify !== false) {
          try {
            const primary = await calendar.getCalendar('primary');
            live = { ok: true, calendarId: primary?.id, summary: primary?.summary, timeZone: primary?.timeZone };
            lines.push(`实时验证：成功（主日历「${primary?.summary ?? primary?.id}」，时区 ${primary?.timeZone ?? '未知'}）`);
          } catch (error) {
            live = { ok: false, message: error?.message };
            lines.push(`实时验证：失败 —— ${error?.message}`);
          }
        }
        if (!status.clientConfigured) {
          lines.push('');
          lines.push('下一步：在 Google Cloud 控制台创建「桌面应用」类型的 OAuth 客户端，启用 Google Calendar API 与 Google Tasks API，'
            + `把下载的 JSON 保存到 ${config.clientSecretFile ?? '(config.clientSecretFile)'}，然后运行 google_auth_begin。`);
        } else if (!status.hasToken) {
          lines.push('');
          lines.push('下一步：运行 google_auth_begin 获取授权链接。');
        }
        return { text: lines.join('\n'), data: { ...status, live } };
      },
    }),

    toolSpec({
      name: 'google_auth_begin',
      title: '开始 Google 授权',
      kind: 'write',
      description: '生成 Google 授权链接并在本机启动回调监听。把返回的链接发给用户，'
        + '用户在浏览器同意后，授权码会被本地服务自动接收；随后调用 google_auth_complete 完成。'
        + '链接默认 15 分钟内有效。',
      parameters: {
        port: intParam('本地回调端口；0 或不填表示自动分配（「桌面应用」类型的 OAuth 客户端允许任意回环端口）'),
        loginHint: stringParam('预填要授权的 Google 账号邮箱，便于多账号用户选择正确的账号'),
        forceConsent: boolParam('是否强制显示同意页以确保拿到 refresh_token（默认 true，建议保持）'),
        timeoutMs: intParam('本次授权链接的有效期（毫秒），默认 900000（15 分钟）'),
      },
      async run(args) {
        const result = await flow.begin({
          port: args?.port,
          loginHint: optionalString(args, 'loginHint'),
          forceConsent: args?.forceConsent !== false,
          timeoutMs: args?.timeoutMs,
        });
        const minutes = Math.round(result.timeoutMs / 60000);
        const text = [
          '请在浏览器中打开下面的链接并同意授权（链接约 ' + minutes + ' 分钟内有效）：',
          '',
          result.url,
          '',
          `本地回调地址：${result.redirectUri}`,
          '授权完成后本机回调服务会自动收到授权码，然后运行 google_auth_complete 写入令牌。',
        ].join('\n');
        return { text, data: result };
      },
    }),

    toolSpec({
      name: 'google_auth_complete',
      title: '完成 Google 授权',
      kind: 'write',
      description: '取回浏览器授权产生的授权码并换取长期令牌（refresh_token）。'
        + '若用户在等待窗口内已完成授权，一次调用即可完成；否则会返回「仍在等待」，'
        + '等用户说已完成后再调用一次即可。也可以直接传入 code 或 redirectUrl 手动完成。',
      parameters: {
        waitMs: intParam('本次最多等待多少毫秒（默认 20000）。返回「仍在等待」时稍后再调一次即可。'),
        code: stringParam('手动传入授权码（当无法使用本地回调时）'),
        redirectUrl: stringParam('手动传入浏览器跳转后的完整回调地址，插件会自动取出其中的 code'),
      },
      async run(args) {
        let code = optionalString(args, 'code');
        let redirectUri = optionalString(args, 'redirectUrl');

        if (redirectUri && !code) {
          try {
            const parsed = new URL(redirectUri);
            code = parsed.searchParams.get('code') ?? undefined;
            const error = parsed.searchParams.get('error');
            if (!code && error) throw new AuthError(`Google 授权失败：${error}`);
            // 回调地址去掉 query 后即为 redirect_uri。
            parsed.search = '';
            redirectUri = parsed.toString();
          } catch (caught) {
            if (caught instanceof AuthError) throw caught;
            throw new ToolInputError(`redirectUrl 不是合法 URL：${redirectUri}`);
          }
        }

        if (!code) {
          const flowStatus = flow.status();
          if (!flowStatus.active) {
            throw new ToolInputError(
              '当前没有正在进行的授权流程。请先运行 google_auth_begin 获取授权链接，'
              + '或在参数中直接提供 code / redirectUrl。',
            );
          }
          const waited = await flow.waitForCode({ timeoutMs: args?.waitMs });
          if (waited.status === 'ok') {
            code = waited.code;
            redirectUri = redirectUri ?? flowStatus.redirectUri;
          } else if (waited.status === 'pending') {
            const secondsLeft = Math.max(0, Math.round((flowStatus.expiresAt - Date.now()) / 1000));
            return {
              text: [
                '仍在等待浏览器完成授权。',
                '',
                '如果还没打开授权链接，请打开：',
                flowStatus.url ?? '',
                '',
                `链接剩余有效时间约 ${secondsLeft} 秒。用户确认授权完成后，再次调用 google_auth_complete 即可完成。`,
                '若链接已失效或授权被拒绝，重新运行 google_auth_begin 生成新链接。',
              ].join('\n'),
              data: { status: 'pending', url: flowStatus.url, redirectUri: flowStatus.redirectUri, secondsLeft },
            };
          } else if (waited.status === 'error') {
            throw new AuthError(waited.error ?? 'Google 授权失败');
          } else if (waited.status === 'cancelled') {
            throw new AuthError('本次授权流程已取消或超时，请重新运行 google_auth_begin。');
          } else {
            throw new ToolInputError('当前没有正在进行的授权流程，请先运行 google_auth_begin。');
          }
        }

        if (!redirectUri) {
          const flowStatus = flow.status();
          redirectUri = flowStatus.redirectUri ?? config.oauthRedirectUri;
        }
        if (!redirectUri) {
          throw new ToolInputError('无法确定 redirect_uri。请重新运行 google_auth_begin，或同时提供 redirectUrl 参数。');
        }

        flow.cancel();
        const done = await finishAuthorization(code, redirectUri);
        const text = [
          'Google 授权完成，令牌已保存。',
          done.email ? `账号：${done.email}` : '账号：已授权（未能读取邮箱）',
          done.scope ? `授权范围：${done.scope}` : '',
          `令牌文件：${config.tokenFile}`,
          '现在可以直接用 gcal_* 与 gtasks_* 工具管理日历与任务了。',
        ].filter(Boolean).join('\n');
        return { text, data: { email: done.email, scope: done.scope, tokenFile: config.tokenFile } };
      },
    }),

    toolSpec({
      name: 'google_auth_reset',
      title: '重置 Google 授权',
      kind: 'danger',
      description: '清除本地保存的 Google 令牌。可选同时在 Google 侧撤销授权。'
        + '用于切换到另一个 Google 账号，或令牌失效后彻底重来。',
      parameters: {
        revoke: boolParam('是否同时在 Google 侧撤销授权（默认 false，仅删除本地令牌文件）'),
        confirm: CONFIRM_PARAM,
      },
      async run(args) {
        guard.confirm(args, { action: '重置 Google 授权', always: true });
        if (args?.revoke === true) {
          const result = await auth.revoke();
          return {
            text: result.revoked
              ? '已在 Google 侧撤销授权，并删除本地令牌。下次使用前请重新运行 google_auth_begin。'
              : `已删除本地令牌；Google 侧撤销未成功（${result.reason ?? '未知原因'}）。`,
            data: result,
          };
        }
        const removed = await auth.clearToken();
        return {
          text: removed ? '已删除本地令牌文件。下次使用前请重新运行 google_auth_begin。' : '本地没有令牌文件，无需清理。',
          data: { removed },
        };
      },
    }),
  ];
}
