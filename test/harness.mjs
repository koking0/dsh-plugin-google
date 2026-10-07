/**
 * 测试夹具：把插件的核心模块直接接到本地模拟的 Google 服务上。
 *
 * 因为 `lib/tools/*` 只导出普通对象（不依赖 DSH 运行时），这里可以完整地端到端验证
 * 工具逻辑：令牌刷新、CRUD 往返、守卫策略与错误翻译都不需要真实凭据。
 *
 * @module dsh-plugin-google/test/harness
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAuth } from '../lib/auth.js';
import { createCalendarApi } from '../lib/calendar-api.js';
import { createGuard } from '../lib/guard.js';
import { createHttpClient } from '../lib/http.js';
import { createConsentFlow } from '../lib/oauth-flow.js';
import { createTasksApi } from '../lib/tasks-api.js';
import { epochFromParts, resolveTimeZone } from '../lib/time.js';
import { createAgendaTools } from '../lib/tools/agenda.js';
import { createAuthTools } from '../lib/tools/auth.js';
import { createCalendarTools } from '../lib/tools/calendar.js';
import { createTasksTools } from '../lib/tools/tasks.js';
import { startMockGoogle } from './mock-google.mjs';

/** 固定的「现在」：2026-10-05（周一）15:49:37 +08:00。 */
export const FIXED_NOW = Date.parse('2026-10-05T15:49:37+08:00');

/**
 * 创建一套接线完成的测试环境。
 *
 * @param {object} [options] - 覆盖项。
 * @param {object} [options.config] - 覆盖插件配置。
 * @param {boolean} [options.seed] - 是否写入模拟数据（默认 true）。
 * @param {number} [options.now] - 固定时钟。
 * @param {boolean} [options.withToken] - 是否预置一个 refresh token（默认 true）。
 * @returns {Promise<object>} 测试环境。
 */
export async function createHarness(options = {}) {
  const mock = await startMockGoogle({ seed: options.seed });
  const dir = await mkdtemp(join(tmpdir(), 'dsh-google-test-'));
  const tokenFile = join(dir, 'token.json');
  const fixedNow = Number.isFinite(options.now) ? options.now : FIXED_NOW;

  const config = {
    clientId: 'client-id-1234567890.apps.googleusercontent.com',
    clientSecret: 'client-secret-value',
    credentialRef: undefined,
    tokenFile,
    oauthRedirectPort: 0,
    oauthCallbackPath: '/oauth2callback',
    oauthFlowTimeoutMs: 60_000,
    timeZone: 'Asia/Shanghai',
    defaultCalendarId: 'primary',
    defaultTaskList: '@default',
    defaultEventMinutes: 60,
    requestTimeoutMs: 10_000,
    rejectUnauthorized: true,
    readOnly: false,
    requireConfirmForWrites: false,
    ...mock.urls,
    ...options.config,
  };

  if (options.withToken !== false) {
    await writeFile(tokenFile, JSON.stringify({ refresh_token: 'rt-seed', scope: 'scope-x', clientId: config.clientId }), 'utf8');
  }

  const timeZone = resolveTimeZone(config.timeZone, 'Asia/Shanghai');
  const now = () => fixedNow;
  const logger = options.logger;

  const http = createHttpClient({ timeoutMs: config.requestTimeoutMs, rejectUnauthorized: true, logger });
  const auth = createAuth({ config, http, logger, now });
  const flow = createConsentFlow({ auth, config, logger, now });
  const calendar = createCalendarApi({ http, auth, baseUrl: config.calendarApiBase, logger });
  const tasks = createTasksApi({ http, auth, baseUrl: config.tasksApiBase, logger });
  const guard = createGuard({ config });

  const deps = { config, guard, auth, flow, calendar, tasks, logger, timeZone, epochFromParts, now };
  const specs = [
    ...createAuthTools(deps),
    ...createCalendarTools(deps),
    ...createTasksTools(deps),
    ...createAgendaTools(deps),
  ];
  const tools = new Map(specs.map((spec) => [spec.name, spec]));

  return {
    mock,
    config,
    deps,
    auth,
    flow,
    calendar,
    tasks,
    guard,
    specs,
    tools,
    tokenFile,
    now: fixedNow,
    /**
     * 调用一个工具并返回 `{ text, data }`。
     * @param {string} name - 工具名。
     * @param {object} [args] - 参数。
     * @returns {Promise<{text:string, data:any}>} 工具结果。
     */
    async call(name, args = {}) {
      const spec = tools.get(name);
      if (!spec) throw new Error(`未知工具 ${name}`);
      return spec.run(args, {});
    },
    /** 读取令牌文件内容。 */
    async readToken() {
      return JSON.parse(await readFile(tokenFile, 'utf8'));
    },
    async close() {
      flow.cancel();
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
