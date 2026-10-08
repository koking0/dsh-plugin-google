/**
 * 本地模拟的 Google API 服务，用于在没有真实凭据的情况下端到端验证插件。
 *
 * 覆盖插件真正调用的全部端点：OAuth 令牌端点、Calendar v3（日历/事件/quickAdd/move/freeBusy）
 * 与 Tasks v1（任务列表/任务/move/clear）。状态保存在内存中，因此 CRUD 往返可被断言。
 *
 * @module dsh-plugin-google/test/mock-google
 */

import http from 'node:http';

/** 解析请求体。 */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** 生成一个自增 ID。 */
function idFactory(prefix) {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}${String(counter).padStart(4, '0')}`;
  };
}

/** 判断事件是否占用时间。 */
function isBusy(event) {
  return event.status !== 'cancelled' && event.transparency !== 'transparent';
}

/**
 * 启动模拟服务。
 *
 * @param {object} [options] - `{ seed }` 是否写入示例数据。
 * @returns {Promise<object>} 服务句柄。
 */
export async function startMockGoogle(options = {}) {
  const seed = options.seed !== false;
  const state = {
    tokenRequests: [],
    validRefreshTokens: new Set(['rt-seed']),
    issuedAccessTokens: new Set(['at-seed']),
    calendars: new Map(),
    events: new Map(),
    taskLists: new Map(),
    tasks: new Map(),
    failures: [],
    requests: [],
  };
  const nextCalendarEventId = idFactory('evt');
  const nextCalendarId = idFactory('cal');
  const nextListId = idFactory('list');
  const nextTaskId = idFactory('task');

  if (seed) {
    state.calendars.set('primary', {
      kind: 'calendarList',
      id: 'primary',
      summary: '主日历',
      timeZone: 'Asia/Shanghai',
      accessRole: 'owner',
      primary: true,
    });
    state.calendars.set('work@example.com', {
      kind: 'calendarList',
      id: 'work@example.com',
      summary: '工作',
      timeZone: 'Asia/Shanghai',
      accessRole: 'writer',
    });
    state.events.set('primary', new Map());
    state.events.set('work@example.com', new Map());
    state.taskLists.set('@default', { id: '@default', title: '我的任务', updated: '2026-10-01T00:00:00.000Z' });
    state.taskLists.set('list0001', { id: 'list0001', title: '工作待办', updated: '2026-10-01T00:00:00.000Z' });
    state.tasks.set('@default', new Map());
    state.tasks.set('list0001', new Map());
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readBody(req);
    state.requests.push({ method: req.method, path: url.pathname, query: url.search });

    const send = (status, payload) => {
      if (payload === undefined) {
        res.writeHead(status).end();
        return;
      }
      const text = JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) }).end(text);
    };
    const fail = (status, error, reason) => send(status, { error: { code: status, message: error, errors: reason ? [{ reason, message: error }] : undefined } });

    // 测试钩子：命中即返回预设失败，只生效一次。
    const injected = state.failures.findIndex((entry) => url.pathname.includes(entry.match));
    if (injected >= 0) {
      const entry = state.failures.splice(injected, 1)[0];
      fail(entry.status, entry.message ?? 'injected failure', entry.reason);
      return;
    }

    try {
      await route({ req, res, url, body, send, fail, state, nextCalendarEventId, nextCalendarId, nextListId, nextTaskId });
    } catch (error) {
      send(500, { error: { code: 500, message: `mock failure: ${error.message}` } });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  return {
    base,
    urls: {
      oauthAuthUrl: `${base}/o/oauth2/v2/auth`,
      oauthTokenUrl: `${base}/token`,
      oauthRevokeUrl: `${base}/revoke`,
      calendarApiBase: `${base}/calendar/v3`,
      tasksApiBase: `${base}/tasks/v1`,
    },
    state,
    /** 注入一次性失败。 */
    failOnce(match, { status, message, reason } = {}) {
      state.failures.push({ match, status: status ?? 500, message, reason });
    },
    /** 直接写入一个日历（用于构造只读订阅日历等场景）。 */
    putCalendar(record) {
      const merged = {
        kind: 'calendarList',
        timeZone: 'Asia/Shanghai',
        accessRole: 'owner',
        ...record,
      };
      state.calendars.set(merged.id, merged);
      if (!state.events.has(merged.id)) state.events.set(merged.id, new Map());
      return merged;
    },
    /** 直接写入一个事件。 */
    putEvent(calendarId, event) {
      if (!state.events.has(calendarId)) state.events.set(calendarId, new Map());
      const id = event.id ?? nextCalendarEventId();
      const record = { ...event, id, etag: '"1"', kind: 'calendar#event' };
      state.events.get(calendarId).set(id, record);
      return record;
    },
    /** 直接写入一个任务。 */
    putTask(listId, task) {
      if (!state.tasks.has(listId)) state.tasks.set(listId, new Map());
      const id = task.id ?? nextTaskId();
      const record = { ...task, id, kind: 'tasks#task' };
      state.tasks.get(listId).set(id, record);
      return record;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
    },
  };
}

/** 该请求是否带着有效的 Bearer 令牌。 */
function authorized(req, state) {
  const header = String(req.headers.authorization ?? '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(match && state.issuedAccessTokens.has(match[1]));
}

/** 路由分发。 */
async function route(context) {
  const { req, url, body, send, fail, state } = context;
  const method = req.method ?? 'GET';
  const path = url.pathname;

  // ---------- OAuth ----------
  if (path === '/token' && method === 'POST') {
    const params = new URLSearchParams(body.toString('utf8'));
    const grant = params.get('grant_type');
    state.tokenRequests.push({ grant, form: Object.fromEntries(params.entries()) });
    if (grant === 'authorization_code') {
      if (!params.get('code')) return fail(400, 'invalid_request', 'missing_code');
      if (!params.get('code_verifier') && params.get('code') === 'bad-code') {
        return send(400, { error: 'invalid_grant', error_description: 'Bad code' });
      }
      const token = `at-code-${state.tokenRequests.length}`;
      state.issuedAccessTokens.add(token);
      return send(200, {
        access_token: token,
        refresh_token: 'rt-1',
        expires_in: 3600,
        scope: params.get('scope') ?? 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks',
        token_type: 'Bearer',
      });
    }
    if (grant === 'refresh_token') {
      const refresh = params.get('refresh_token');
      if (!state.validRefreshTokens.has(refresh)) {
        return send(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      }
      const token = `at-refresh-${state.tokenRequests.length}`;
      state.issuedAccessTokens.add(token);
      return send(200, { access_token: token, expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar', token_type: 'Bearer' });
    }
    return fail(400, `unsupported grant_type ${grant}`);
  }
  if (path === '/revoke' && method === 'POST') {
    const params = new URLSearchParams(body.toString('utf8'));
    state.validRefreshTokens.delete(params.get('token'));
    return send(200, {});
  }

  // 除令牌端点外，全部要求 Bearer 令牌。
  if (!authorized(req, state)) {
    return send(401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError', message: 'Invalid Credentials' }] } });
  }

  // ---------- Calendar v3 ----------
  if (path === '/calendar/v3/users/me/calendarList' && method === 'GET') {
    const items = [...state.calendars.values()].filter((item) => (url.searchParams.get('showHidden') === 'true' ? true : item.hidden !== true));
    return send(200, { kind: 'calendar#calendarList', items });
  }
  if (path === '/calendar/v3/calendars' && method === 'POST') {
    const payload = JSON.parse(body.toString('utf8') || '{}');
    const id = `${context.nextCalendarId()}@group.calendar.google.com`;
    const record = { ...payload, id, kind: 'calendar#calendar', etag: '"1"' };
    state.calendars.set(id, { ...record, kind: 'calendarList', accessRole: 'owner' });
    state.events.set(id, new Map());
    return send(200, record);
  }
  if (path === '/calendar/v3/freeBusy' && method === 'POST') {
    const payload = JSON.parse(body.toString('utf8') || '{}');
    const calendars = {};
    for (const item of payload.items ?? []) {
      const events = [...(state.events.get(item.id)?.values() ?? [])].filter(isBusy);
      calendars[item.id] = {
        busy: events
          .filter((event) => event.start?.dateTime && event.end?.dateTime)
          .map((event) => ({ start: event.start.dateTime, end: event.end.dateTime })),
      };
    }
    return send(200, { kind: 'calendar#freeBusy', timeMin: payload.timeMin, timeMax: payload.timeMax, calendars });
  }

  const calendarMatch = /^\/calendar\/v3\/calendars\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (calendarMatch) {
    const calendarId = decodeURIComponent(calendarMatch[1]);
    const rest = calendarMatch[2] ?? '';
    if (!state.calendars.has(calendarId)) return fail(404, 'Not Found', 'notFound');

    if (rest === '' && method === 'GET') return send(200, state.calendars.get(calendarId));
    if (rest === '' && method === 'PATCH') {
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const updated = { ...state.calendars.get(calendarId), ...payload };
      state.calendars.set(calendarId, updated);
      return send(200, updated);
    }
    if (rest === '' && method === 'DELETE') {
      state.calendars.delete(calendarId);
      state.events.delete(calendarId);
      return send(204);
    }

    const events = state.events.get(calendarId) ?? new Map();
    state.events.set(calendarId, events);

    if (rest === 'events' && method === 'GET') {
      let items = [...events.values()];
      const q = url.searchParams.get('q');
      if (q) {
        const needle = q.toLowerCase();
        items = items.filter((event) => `${event.summary ?? ''} ${event.description ?? ''} ${event.location ?? ''}`.toLowerCase().includes(needle));
      }
      const timeMin = url.searchParams.get('timeMin');
      const timeMax = url.searchParams.get('timeMax');
      if (timeMin) items = items.filter((event) => eventStart(event) >= Date.parse(timeMin));
      if (timeMax) items = items.filter((event) => eventStart(event) < Date.parse(timeMax));
      if (url.searchParams.get('showDeleted') !== 'true') items = items.filter((event) => event.status !== 'cancelled');
      const orderBy = url.searchParams.get('orderBy');
      if (orderBy === 'startTime') items.sort((a, b) => eventStart(a) - eventStart(b));
      const maxResults = Number(url.searchParams.get('maxResults') ?? 250);
      const limited = items.slice(0, maxResults);
      const response = { kind: 'calendar#events', items: limited };
      if (items.length > limited.length) response.nextPageToken = `page-${limited.length}`;
      return send(200, response);
    }
    if (rest === 'events' && method === 'POST') {
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const id = context.nextCalendarEventId();
      const record = { ...payload, id, kind: 'calendar#event', etag: '"1"', status: payload.status ?? 'confirmed', htmlLink: `https://calendar.google.com/event?eid=${id}` };
      events.set(id, record);
      return send(200, record);
    }

    const quickAdd = /^events\/quickAdd$/.exec(rest);
    if (quickAdd && method === 'POST') {
      const text = url.searchParams.get('text') ?? '';
      const id = context.nextCalendarEventId();
      const record = {
        id,
        kind: 'calendar#event',
        // 真实 Google 返回的事件一定有 status，mock 也补齐，避免测出假象。
        status: 'confirmed',
        summary: text,
        start: { dateTime: '2026-10-06T15:00:00+08:00', timeZone: 'Asia/Shanghai' },
        end: { dateTime: '2026-10-06T16:00:00+08:00', timeZone: 'Asia/Shanghai' },
      };
      events.set(id, record);
      return send(200, record);
    }

    const eventMatch = /^events\/([^/]+)(?:\/(move))?$/.exec(rest);
    if (eventMatch) {
      const eventId = decodeURIComponent(eventMatch[1]);
      const isMove = eventMatch[2] === 'move';
      const event = events.get(eventId);
      if (!event) return fail(404, 'Not Found', 'notFound');

      if (isMove && method === 'POST') {
        const destination = url.searchParams.get('destination');
        if (!destination || !state.calendars.has(destination)) return fail(404, 'Not Found', 'notFound');
        events.delete(eventId);
        const target = state.events.get(destination) ?? new Map();
        state.events.set(destination, target);
        target.set(eventId, event);
        // 真实 API 的实测行为：`events.move` 的响应会带上源日历那份「已取消」墓碑的
        // status，而目标日历里实际存的是 confirmed。这里刻意复现，用来锁住
        // 「移动后必须回读再确认」这条修复 —— 否则确认文案会出现
        // 「已移动日程……（已取消）」这种自相矛盾的话。
        return send(200, { ...event, status: 'cancelled' });
      }
      if (method === 'GET') return send(200, event);
      if (method === 'PATCH') {
        const payload = JSON.parse(body.toString('utf8') || '{}');
        const updated = { ...event, ...payload };
        events.set(eventId, updated);
        return send(200, updated);
      }
      if (method === 'DELETE') {
        events.delete(eventId);
        return send(204);
      }
    }
  }

  // ---------- Tasks v1 ----------
  if (path === '/tasks/v1/users/@me/lists' && method === 'GET') {
    const items = [...state.taskLists.values()];
    const maxResults = Number(url.searchParams.get('maxResults') ?? 100);
    return send(200, { kind: 'tasks#taskLists', items: items.slice(0, maxResults) });
  }
  if (path === '/tasks/v1/users/@me/lists' && method === 'POST') {
    const payload = JSON.parse(body.toString('utf8') || '{}');
    const id = context.nextListId();
    const record = { id, title: payload.title, updated: new Date(0).toISOString(), kind: 'tasks#taskList' };
    state.taskLists.set(id, record);
    state.tasks.set(id, new Map());
    return send(200, record);
  }

  const listMatch = /^\/tasks\/v1\/users\/@me\/lists\/([^/]+)$/.exec(path);
  if (listMatch) {
    const listId = decodeURIComponent(listMatch[1]);
    const list = state.taskLists.get(listId);
    if (!list) return fail(404, 'Not Found', 'notFound');
    if (method === 'GET') return send(200, list);
    if (method === 'PATCH') {
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const updated = { ...list, ...payload };
      state.taskLists.set(listId, updated);
      return send(200, updated);
    }
    if (method === 'DELETE') {
      state.taskLists.delete(listId);
      state.tasks.delete(listId);
      return send(204);
    }
  }

  const tasksMatch = /^\/tasks\/v1\/lists\/([^/]+)\/(tasks|clear)(?:\/([^/]+))?(?:\/(move))?$/.exec(path);
  if (tasksMatch) {
    const listId = decodeURIComponent(tasksMatch[1]);
    const section = tasksMatch[2];
    const taskId = tasksMatch[3] ? decodeURIComponent(tasksMatch[3]) : undefined;
    const isMove = tasksMatch[4] === 'move';
    if (!state.taskLists.has(listId)) return fail(404, 'Not Found', 'notFound');
    const store = state.tasks.get(listId) ?? new Map();
    state.tasks.set(listId, store);

    if (section === 'clear' && method === 'POST') {
      for (const [id, task] of [...store.entries()]) {
        if (task.status === 'completed') store.delete(id);
      }
      return send(204);
    }

    if (section === 'tasks' && taskId === undefined && method === 'GET') {
      let items = [...store.values()];
      if (url.searchParams.get('showCompleted') === 'false') items = items.filter((task) => task.status !== 'completed');
      if (url.searchParams.get('showHidden') !== 'true') items = items.filter((task) => task.hidden !== true);
      const dueMin = url.searchParams.get('dueMin');
      const dueMax = url.searchParams.get('dueMax');
      // 与真实 API 一致：指定了 due 范围时，没有截止日期的任务被排除。
      if (dueMin) items = items.filter((task) => task.due && Date.parse(task.due) >= Date.parse(dueMin));
      if (dueMax) items = items.filter((task) => task.due && Date.parse(task.due) <= Date.parse(dueMax));
      const maxResults = Number(url.searchParams.get('maxResults') ?? 100);
      return send(200, { kind: 'tasks#tasks', items: items.slice(0, maxResults) });
    }
    if (section === 'tasks' && taskId === undefined && method === 'POST') {
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const id = context.nextTaskId();
      const parent = url.searchParams.get('parent');
      const record = {
        id,
        title: payload.title,
        notes: payload.notes,
        due: payload.due,
        status: payload.status ?? 'needsAction',
        position: String(store.size).padStart(20, '0'),
        ...(parent ? { parent } : {}),
        kind: 'tasks#task',
      };
      store.set(id, record);
      return send(200, record);
    }

    const existing = taskId ? store.get(taskId) : undefined;
    if (taskId && !existing) return fail(404, 'Not Found', 'notFound');

    if (isMove && method === 'POST') {
      const destination = url.searchParams.get('destinationTasklist');
      const parent = url.searchParams.get('parent');
      let moved = { ...existing };
      if (parent !== null) moved.parent = parent;
      if (destination && destination !== listId) {
        store.delete(taskId);
        const target = state.tasks.get(destination) ?? new Map();
        state.tasks.set(destination, target);
        target.set(taskId, moved);
      } else {
        store.set(taskId, moved);
      }
      return send(200, moved);
    }
    if (method === 'GET') return send(200, existing);
    if (method === 'PATCH') {
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const updated = { ...existing };
      for (const [key, value] of Object.entries(payload)) {
        if (value === null) delete updated[key];
        else updated[key] = value;
      }
      if (updated.status === 'completed' && !updated.completed) updated.completed = new Date(0).toISOString();
      if (updated.status === 'needsAction') delete updated.completed;
      store.set(taskId, updated);
      return send(200, updated);
    }
    if (method === 'DELETE') {
      store.delete(taskId);
      return send(204);
    }
  }

  return fail(404, `no mock route for ${method} ${path}`, 'notFound');
}

/** 事件的开始时刻。 */
function eventStart(event) {
  const value = event.start?.dateTime ?? event.start?.date;
  const epoch = Date.parse(value ?? '');
  return Number.isFinite(epoch) ? epoch : 0;
}
