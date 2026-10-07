/**
 * Google 日历与任务插件入口。
 *
 * 把 Google Calendar API v3 与 Google Tasks API v1 封装成 DSH 原生工具，支持通过对话完成
 * 日程与待办的增删改查。不依赖任何第三方运行时库：HTTP 走 `node:https`，OAuth 2.0 自行实现，
 * 因此可以精确控制代理、超时与令牌存储，也不需要额外的 Python/Node 中间服务。
 *
 * 结构上刻意把「工具规格」与「DSH 注册」分开：`lib/tools/*` 只导出普通对象，
 * 由本文件统一包装成 `defineTool`，这样工具逻辑可以直接用 Node 单元测试。
 *
 * @module dsh-plugin-google
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { createAuth, DEFAULT_SCOPES } from './lib/auth.js';
import { createCalendarApi } from './lib/calendar-api.js';
import { createConsentFlow } from './lib/oauth-flow.js';
import { textBlock } from './lib/format.js';
import { createGuard } from './lib/guard.js';
import { createHttpClient } from './lib/http.js';
import { toLosslessJson } from './lib/json.js';
import { resolveDefaultTimeZone, resolvePluginPaths } from './lib/paths.js';
import { createTasksApi } from './lib/tasks-api.js';
import { epochFromParts, resolveTimeZone } from './lib/time.js';
import { createAgendaTools } from './lib/tools/agenda.js';
import { createAuthTools } from './lib/tools/auth.js';
import { createCalendarTools } from './lib/tools/calendar.js';
import { createTasksTools } from './lib/tools/tasks.js';

export const name = 'google';

/** 依赖工具注册表与系统提示词注册表（两者都由 dsh-base 提供）。 */
export const inject = ['tools', 'systemPrompt'];

/** 提示词区块的排序位；紧随 MCP 与其它插件区块之后。 */
const PROMPT_SECTION_ORDER = 3160;

/** 统一的工具输出 schema。 */
const OUTPUT_SCHEMA = { type: 'json', description: '返回 text（中文摘要）与 data（结构化数据）。' };

/** 插件配置。 */
export const Config = z.object({
  // ---- OAuth 客户端凭据 ----
  /** 直接给出 client_id（仅建议临时使用）。 */
  clientId: z.string(),
  /** 直接给出 client_secret。 */
  clientSecret: z.string(),
  /**
   * Google Cloud 下载的 OAuth 客户端 JSON 路径（推荐，支持 installed / web / 平铺三种结构）。
   * 不填则默认读取 `$DSH_HOME/google-oauth-client.json`（即 `~/.dsh/google-oauth-client.json`）。
   */
  clientSecretFile: z.string(),
  /** 交由 DSH 凭据服务解析的引用名，值为客户端 JSON 或 `id:secret`。 */
  credentialRef: z.string().default('GOOGLE_OAUTH_CLIENT'),
  /**
   * 长期令牌（refresh token）的存放路径。
   * 不填则默认使用 `$DSH_HOME/google-oauth-token.json`，授权成功后自动写入。
   */
  tokenFile: z.string(),

  // ---- 授权回调 ----
  /** 本地回调端口；0 表示自动分配（「桌面应用」类型的客户端允许任意回环端口）。 */
  oauthRedirectPort: z.number().default(0),
  /** 固定回调地址；使用「Web 应用」类型的客户端时需要在此填写已登记的地址。 */
  oauthRedirectUri: z.string(),
  /** 回调路径。 */
  oauthCallbackPath: z.string().default('/oauth2callback'),
  /** 授权链接的有效期（毫秒）。 */
  oauthFlowTimeoutMs: z.number().default(900000),

  // ---- 端点（可覆盖，便于自建代理与测试）----
  oauthAuthUrl: z.string(),
  oauthTokenUrl: z.string(),
  oauthRevokeUrl: z.string(),
  calendarApiBase: z.string().default('https://www.googleapis.com/calendar/v3'),
  tasksApiBase: z.string().default('https://tasks.googleapis.com/tasks/v1'),

  // ---- 默认行为 ----
  /**
   * 解释自然语言时间与展示时间所用时区。
   * 不填则使用**系统时区**，这样不同时区的用户装完即可用。
   */
  timeZone: z.string(),
  /** 默认操作的日历；`primary` 表示主日历。 */
  defaultCalendarId: z.string().default('primary'),
  /** 默认操作的任务列表；`@default` 表示默认列表。 */
  defaultTaskList: z.string().default('@default'),
  /**
   * 视为「他人日程」的日历 ID：这些日历里的安排会照常展示，
   * 但不参与 google_agenda 的冲突判定（例如研究生的课表）。
   */
  otherCalendarIds: z.array(z.string()).default([]),
  /** 只给开始时间时，定时日程的默认时长（分钟）。 */
  defaultEventMinutes: z.number().default(60),
  /** 申请的 OAuth 权限范围。 */
  scopes: z.array(z.string()).default(DEFAULT_SCOPES),

  // ---- 网络 ----
  /** HTTP(S) 代理，例如 `http://127.0.0.1:7890`；留空则读取 HTTPS_PROXY 等环境变量。 */
  proxy: z.string(),
  /** 是否校验 TLS 证书。 */
  rejectUnauthorized: z.boolean().default(true),
  /** 单次请求超时（毫秒）。 */
  requestTimeoutMs: z.number().default(30000),

  // ---- 安全 ----
  /** 全局只读开关。 */
  readOnly: z.boolean().default(false),
  /** 为 true 时所有写入都要求 confirm: true（删除类操作始终要求）。 */
  requireConfirmForWrites: z.boolean().default(false),
});

/**
 * 把普通工具规格包装成 DSH 工具定义。
 *
 * `data` 会先经过 {@link toLosslessJson}：工具实现里常见的
 * `xxx: cond ? value : undefined` 在普通 JS 里无害，但 DSH 会以
 * `value is not lossless JSON` 拒绝整次调用，因此统一在协议边界清洗。
 *
 * @param {object} spec - `lib/tools/*` 导出的规格。
 * @returns {object} 可注册的工具定义。
 */
function toDefinition(spec) {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(value?.text ?? '(空结果)'),
    },
    async execute(args, exec) {
      const result = await spec.run(args ?? {}, exec);
      return {
        text: result?.text ?? '(空结果)',
        data: toLosslessJson(result?.data ?? null),
      };
    },
    presentCall: (args) => ({ card: 'generic', title: spec.title ?? spec.name, kind: spec.kind ?? 'other', rawInput: args }),
  });
}

/**
 * 注册 Google 日历与任务工具集。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} config - 已校验的插件配置。
 */
export function apply(ctx, rawConfig) {
  const logger = ctx.logger ?? undefined;

  // 把「按机器解析」的路径与时区固化下来，后续一律使用这份配置。
  // 这样 bundle 的 cordis.patch.yml 就不必（也不该）写死任何绝对路径。
  const paths = resolvePluginPaths(rawConfig);
  const config = {
    ...rawConfig,
    clientSecretFile: paths.clientSecretFile,
    tokenFile: paths.tokenFile,
  };
  const timeZone = resolveTimeZone(resolveDefaultTimeZone(rawConfig.timeZone), 'Asia/Shanghai');

  const http = createHttpClient({
    timeoutMs: Number(config.requestTimeoutMs) || 30000,
    rejectUnauthorized: config.rejectUnauthorized !== false,
    proxy: config.proxy,
    logger,
  });

  // DSH 凭据服务是可选依赖：不存在时自动回退到配置文件与环境变量。
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;

  const auth = createAuth({ config, http, logger, credentials });
  const flow = createConsentFlow({ auth, config, logger });
  const calendar = createCalendarApi({ http, auth, baseUrl: config.calendarApiBase, logger });
  const tasks = createTasksApi({ http, auth, baseUrl: config.tasksApiBase, logger });
  const guard = createGuard({ config });

  const deps = {
    config,
    guard,
    auth,
    flow,
    calendar,
    tasks,
    logger,
    timeZone,
    epochFromParts,
    now: () => Date.now(),
  };

  const specs = [
    ...createAuthTools(deps),
    ...createCalendarTools(deps),
    ...createTasksTools(deps),
    ...createAgendaTools(deps),
  ];

  for (const spec of specs) ctx.tools.register(toDefinition(spec));

  // 插件卸载时关掉可能仍在监听的本地回调服务。
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      try {
        flow.cancel();
      } catch (error) {
        logger?.debug?.('[google] 关闭授权回调服务失败', { message: error?.message });
      }
    });
  }

  ctx.systemPrompt.section({
    name: 'plugin:google',
    order: PROMPT_SECTION_ORDER,
    text: () => {
      const mode = guard.readOnly
        ? '当前为只读模式（config.readOnly = true），写入类工具会直接拒绝。'
        : '写入类工具可用；删除类操作必须显式传 confirm: true。';
      return [
        '## Google 日历与任务',
        `已接入 Google Calendar 与 Google Tasks，工具名以 gcal_ / gtasks_ 开头，`
        + `另有 google_agenda（日历+待办汇总）与 google_auth_*（授权管理）。`
        + `所有时间均按 ${timeZone} 时区解释与展示。`,
        '时间参数直接写中文自然语言即可：「明天下午3点」「下周一 10:00」「+2h」「本周」；插件会在服务端解析。',
        '回答「今天/这周有什么安排」时优先用 google_agenda，它一次返回按天排列的日程、当天到期待办、逾期任务与时间冲突。',
        '先读后写：不确定事件 ID、日历 ID 或任务列表 ID 时，先用 gcal_list_events / gcal_list_calendars / '
        + 'gtasks_list_tasks / gtasks_list_tasklists 获取。',
        '日程 ID 在 gcal_list_events 的结果里以 id= 形式给出；修改或删除前先用它确认对象。',
        '引用默认资源可以省略参数：日历默认用主日历，任务默认用默认列表；也可以把 calendarId / taskListId 传 all 做跨日历或跨列表查询。',
        '创建日程时传 attendees 会默认给参与者发送邀请；需要精确控制通知时可显式传 sendUpdates。',
        'Google Tasks 的截止日期只精确到「日」，不保存具体时刻。',
        '删除日程、删除任务、清空已完成任务、删除日历/任务列表都属于不可恢复操作：'
        + '必须先向用户确认，再带 confirm: true 调用。',
        '如果工具报出「尚未完成 Google 授权」，依次运行 google_auth_status 查看状态、'
        + 'google_auth_begin 拿到授权链接发给用户、用户同意后运行 google_auth_complete 完成。',
        mode,
      ].join(' ');
    },
  });

  logger?.info?.('[google] 插件已激活', {
    tools: specs.length,
    timeZone,
    readOnly: guard.readOnly,
    calendarApiBase: config.calendarApiBase,
    tasksApiBase: config.tasksApiBase,
    proxy: config.proxy || '(环境变量或直连)',
  });
}
