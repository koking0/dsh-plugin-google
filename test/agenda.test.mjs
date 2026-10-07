/**
 * 汇总视图（google_agenda）与 HTTP 传输层测试。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { createHttpClient, HttpError } from '../lib/http.js';
import { createHarness } from './harness.mjs';

async function withHarness(options, fn) {
  const harness = await createHarness(options);
  try {
    await fn(harness);
  } finally {
    await harness.close();
  }
}

// ---------------------------------------------------------------- 汇总视图

test('google_agenda 合并当天日程与待办', async () => {
  await withHarness({}, async (h) => {
    h.mock.putEvent('primary', {
      summary: '晨会',
      start: { dateTime: '2026-10-05T09:30:00+08:00' },
      end: { dateTime: '2026-10-05T10:00:00+08:00' },
    });
    h.mock.putTask('@default', { title: '提交周报', due: '2026-10-05T00:00:00.000Z', status: 'needsAction' });
    h.mock.putTask('list0001', { title: '明天的任务', due: '2026-10-06T00:00:00.000Z', status: 'needsAction' });

    const result = await h.call('google_agenda', {});
    assert.match(result.text, /2026-10-05 周一/);
    assert.match(result.text, /晨会/);
    assert.match(result.text, /提交周报/);
    // 明天的任务不属于今天的视图。
    assert.doesNotMatch(result.text, /明天的任务/);
    assert.equal(result.data.days.length, 1);
    assert.equal(result.data.days[0].events.length, 1);
    assert.equal(result.data.days[0].tasks.length, 1);
  });
});

test('google_agenda 单独列出逾期未完成任务', async () => {
  await withHarness({}, async (h) => {
    h.mock.putTask('@default', { title: '上周就该做的事', due: '2026-10-01T00:00:00.000Z', status: 'needsAction' });
    h.mock.putTask('@default', { title: '已完成的历史任务', due: '2026-10-01T00:00:00.000Z', status: 'completed', completed: '2026-10-01T10:00:00.000Z' });

    const result = await h.call('google_agenda', {});
    assert.match(result.text, /已逾期未完成（1）/);
    assert.match(result.text, /上周就该做的事/);
    assert.doesNotMatch(result.text, /已完成的历史任务/);
    assert.equal(result.data.overdue.length, 1);

    const withoutOverdue = await h.call('google_agenda', { includeOverdue: false });
    assert.doesNotMatch(withoutOverdue.text, /已逾期未完成/);
  });
});

test('google_agenda 支持多天视图与任务列表限定', async () => {
  await withHarness({}, async (h) => {
    h.mock.putEvent('primary', {
      summary: '周三评审',
      start: { dateTime: '2026-10-07T14:00:00+08:00' },
      end: { dateTime: '2026-10-07T15:00:00+08:00' },
    });
    h.mock.putTask('@default', { title: '默认列表任务', due: '2026-10-06T00:00:00.000Z', status: 'needsAction' });
    h.mock.putTask('list0001', { title: '工作列表任务', due: '2026-10-06T00:00:00.000Z', status: 'needsAction' });

    const week = await h.call('google_agenda', { date: '今天', days: 7 });
    assert.equal(week.data.days.length, 7);
    assert.match(week.text, /周三评审/);
    assert.match(week.text, /默认列表任务/);
    assert.match(week.text, /工作列表任务/);

    const scoped = await h.call('google_agenda', { date: '今天', days: 7, taskListId: 'list0001' });
    assert.match(scoped.text, /工作列表任务/);
    assert.doesNotMatch(scoped.text, /默认列表任务/);
  });
});

test('google_agenda 跨日历提示时间冲突', async () => {
  await withHarness({}, async (h) => {
    h.mock.putEvent('primary', {
      summary: '会议 A',
      start: { dateTime: '2026-10-05T09:00:00+08:00' },
      end: { dateTime: '2026-10-05T10:00:00+08:00' },
    });
    h.mock.putEvent('primary', {
      summary: '会议 B',
      start: { dateTime: '2026-10-05T09:30:00+08:00' },
      end: { dateTime: '2026-10-05T10:30:00+08:00' },
    });
    const sameCalendar = await h.call('google_agenda', {});
    assert.match(sameCalendar.text, /时间冲突（1 组）/);
    assert.match(sameCalendar.text, /会议 A/);
    assert.match(sameCalendar.text, /会议 B/);
    assert.equal(sameCalendar.data.conflicts.length, 1);

    // 关键场景：课表放在另一个日历，生活事件放在自己的日历——跨日历的重叠必须被发现。
    h.mock.putEvent('work@example.com', {
      summary: '课程：近似算法',
      start: { dateTime: '2026-10-05T09:15:00+08:00' },
      end: { dateTime: '2026-10-05T09:45:00+08:00' },
    });
    const crossCalendar = await h.call('google_agenda', {});
    // 新事件与 A、B 都重叠，因此共 3 组。
    assert.equal(crossCalendar.data.conflicts.length, 3);
    assert.match(crossCalendar.text, /课程：近似算法/);
    // 冲突记录里带上日历信息，便于判断「哪边该让」。
    const pair = crossCalendar.data.conflicts.find((item) => item.summaryA === '课程：近似算法'
      || item.summaryB === '课程：近似算法');
    assert.ok(pair);
    assert.ok([pair.calendarIdA, pair.calendarIdB].includes('work@example.com'));
  });
});

test('google_agenda 可通过 otherCalendarIds 把「他人日历」排除出冲突判定', async () => {
  // 典型场景：研究生的课表单独放在他们的日历里，你和他们时间重叠是正常的。
  await withHarness({ config: { otherCalendarIds: ['work@example.com'] } }, async (h) => {
    h.mock.putEvent('primary', {
      summary: '我的会议',
      start: { dateTime: '2026-10-05T09:00:00+08:00' },
      end: { dateTime: '2026-10-05T10:00:00+08:00' },
    });
    h.mock.putEvent('work@example.com', {
      summary: '学生的课',
      start: { dateTime: '2026-10-05T09:30:00+08:00' },
      end: { dateTime: '2026-10-05T10:30:00+08:00' },
    });

    const result = await h.call('google_agenda', {});
    // 他人的安排照常展示……
    assert.match(result.text, /学生的课/);
    // ……但不判定为「我的冲突」。
    assert.equal(result.data.conflicts.length, 0);
    assert.doesNotMatch(result.text, /时间冲突/);
  });
});

test('google_agenda 显式指定 calendars 时默认不再附带待办', async () => {
  await withHarness({}, async (h) => {
    h.mock.putTask('@default', { title: '今天的待办', due: '2026-10-05T00:00:00.000Z', status: 'needsAction' });
    h.mock.putEvent('work@example.com', {
      summary: '学生的课',
      start: { dateTime: '2026-10-05T09:00:00+08:00' },
      end: { dateTime: '2026-10-05T10:00:00+08:00' },
    });

    // 只看某个日历时，全局待办（尤其几十条逾期）会淹没真正要看的日程，因此默认不带。
    const scoped = await h.call('google_agenda', { calendars: ['work@example.com'] });
    assert.match(scoped.text, /学生的课/);
    assert.doesNotMatch(scoped.text, /今天的待办/);

    // 显式要求仍然可以带上。
    const withTasks = await h.call('google_agenda', { calendars: ['work@example.com'], includeTasks: true });
    assert.match(withTasks.text, /今天的待办/);

    // 不指定 calendars 时默认行为不变。
    const all = await h.call('google_agenda', {});
    assert.match(all.text, /今天的待办/);
  });
});

test('google_agenda 逾期任务只预览前 15 条', async () => {
  await withHarness({}, async (h) => {
    for (let index = 0; index < 20; index += 1) {
      h.mock.putTask('@default', {
        title: `逾期任务 ${index}`,
        due: '2026-10-01T00:00:00.000Z',
        status: 'needsAction',
      });
    }
    const result = await h.call('google_agenda', {});
    assert.match(result.text, /已逾期未完成（20）/);
    assert.match(result.text, /另有 5 条逾期任务未列出/);
    // 结构化数据仍然完整。
    assert.equal(result.data.overdue.length, 20);
  });
});

test('google_agenda 不把只读订阅日历算作冲突', async () => {
  await withHarness({}, async (h) => {
    h.mock.putCalendar({ id: 'holiday@group.v.calendar.google.com', summary: '节假日', accessRole: 'reader' });
    h.mock.putEvent('holiday@group.v.calendar.google.com', {
      summary: '国庆假期',
      start: { dateTime: '2026-10-05T09:00:00+08:00' },
      end: { dateTime: '2026-10-05T18:00:00+08:00' },
    });
    h.mock.putEvent('primary', {
      summary: '会议 A',
      start: { dateTime: '2026-10-05T09:30:00+08:00' },
      end: { dateTime: '2026-10-05T10:00:00+08:00' },
    });

    const result = await h.call('google_agenda', {});
    // 事件仍然照常展示，但不因为节假日日历而产生「冲突」噪音。
    assert.match(result.text, /国庆假期/);
    assert.equal(result.data.conflicts.length, 0);
    assert.doesNotMatch(result.text, /时间冲突/);
  });
});

test('google_agenda 全天事件不参与冲突判定', async () => {
  await withHarness({}, async (h) => {
    h.mock.putEvent('primary', {
      summary: '出差',
      start: { date: '2026-10-05' },
      end: { date: '2026-10-06' },
    });
    h.mock.putEvent('primary', {
      summary: '会议 A',
      start: { dateTime: '2026-10-05T09:00:00+08:00' },
      end: { dateTime: '2026-10-05T10:00:00+08:00' },
    });
    const result = await h.call('google_agenda', {});
    assert.equal(result.data.conflicts.length, 0);
  });
});

test('google_agenda 默认不列无期限任务，可按需开启', async () => {
  await withHarness({}, async (h) => {
    h.mock.putTask('@default', { title: '没有期限的杂事', status: 'needsAction' });
    const off = await h.call('google_agenda', {});
    assert.doesNotMatch(off.text, /没有期限的杂事/);
    const on = await h.call('google_agenda', { includeUndated: true });
    assert.match(on.text, /没有期限的杂事/);
    assert.equal(on.data.undated.length, 1);
  });
});

// ---------------------------------------------------------------- HTTP 传输层

/** 起一个回显请求信息的服务。 */
async function startEchoServer(host = '127.0.0.1') {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.url?.startsWith('/slow')) {
      setTimeout(() => res.writeHead(200).end('{}'), 500);
      return;
    }
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { location: '/target' }).end();
      return;
    }
    if (req.url?.startsWith('/error')) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED', errors: [{ reason: 'forbidden', message: 'no' }] },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      contentType: req.headers['content-type'],
      body,
      host: req.headers.host,
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return { server, port: server.address().port };
}

test('http 客户端序列化查询参数与 JSON 请求体', async () => {
  const echo = await startEchoServer();
  try {
    const client = createHttpClient({ timeoutMs: 5000 });
    const response = await client.get(`http://127.0.0.1:${echo.port}/x`, {
      query: { singleEvents: true, maxResults: 5, items: ['a', 'b'], skip: undefined },
      headers: { authorization: 'Bearer t' },
    });
    const url = new URL(response.json.url, `http://127.0.0.1:${echo.port}`);
    assert.equal(url.searchParams.get('singleEvents'), 'true');
    assert.equal(url.searchParams.get('maxResults'), '5');
    assert.deepEqual(url.searchParams.getAll('items'), ['a', 'b']);
    assert.equal(url.searchParams.has('skip'), false);
    assert.equal(response.json.authorization, 'Bearer t');

    const posted = await client.post(`http://127.0.0.1:${echo.port}/y`, { json: { summary: '评审' } });
    assert.match(posted.json.contentType, /application\/json/);
    assert.equal(posted.json.body, '{"summary":"评审"}');

    const formed = await client.post(`http://127.0.0.1:${echo.port}/z`, { form: { grant_type: 'refresh_token', refresh_token: 'rt' } });
    assert.match(formed.json.contentType, /application\/x-www-form-urlencoded/);
    assert.equal(formed.json.body, 'grant_type=refresh_token&refresh_token=rt');
  } finally {
    await new Promise((resolve) => echo.server.close(resolve));
  }
});

test('http 客户端跟随重定向并把 Google 错误翻译成可读文本', async () => {
  const echo = await startEchoServer();
  try {
    const client = createHttpClient({ timeoutMs: 5000 });
    const redirected = await client.get(`http://127.0.0.1:${echo.port}/redirect`);
    assert.equal(redirected.json.url, '/target');

    await assert.rejects(
      () => client.get(`http://127.0.0.1:${echo.port}/error`),
      (error) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 403);
        assert.match(error.message, /PERMISSION_DENIED/);
        assert.match(error.message, /原因：forbidden/);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => echo.server.close(resolve));
  }
});

test('http 客户端支持超时与取消', async () => {
  const echo = await startEchoServer();
  try {
    const client = createHttpClient({ timeoutMs: 100 });
    await assert.rejects(() => client.get(`http://127.0.0.1:${echo.port}/slow`), /请求超时/);

    const controller = new AbortController();
    const pending = createHttpClient({ timeoutMs: 5000 }).get(`http://127.0.0.1:${echo.port}/slow`, { signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, /调用已取消/);
  } finally {
    await new Promise((resolve) => echo.server.close(resolve));
  }
});

test('http 客户端可经 HTTP CONNECT 代理访问非回环地址', async (t) => {
  // 只有在本机支持把服务绑定到 127.0.0.2（回环网段别名）时才能验证「经过代理」这条路径：
  // 客户端对 127.0.0.1 会刻意直连，因此需要一个非 127.0.0.1 的目标地址。
  let echo;
  try {
    echo = await startEchoServer('127.0.0.2');
  } catch {
    t.skip('当前环境不支持绑定 127.0.0.2，跳过代理隧道测试');
    return;
  }
  const connectRequests = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, clientSocket, head) => {
    connectRequests.push(req.url);
    const [host, port] = String(req.url).split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;
  // 用于验证「回环地址直连、不走代理」的第二个服务。
  const loopbackEcho = await startEchoServer('127.0.0.1');

  try {
    const client = createHttpClient({ timeoutMs: 5000, proxy: `http://127.0.0.1:${proxyPort}` });
    const response = await client.get(`http://127.0.0.2:${echo.port}/through-proxy`, { query: { q: '1' } });
    assert.equal(response.json.url, '/through-proxy?q=1');
    assert.equal(response.json.host, `127.0.0.2:${echo.port}`);
    assert.deepEqual(connectRequests, [`127.0.0.2:${echo.port}`]);

    // 回环地址不走代理。
    connectRequests.length = 0;
    const direct = await client.get(`http://127.0.0.1:${loopbackEcho.port}/direct`);
    assert.equal(direct.json.url, '/direct');
    assert.deepEqual(connectRequests, []);
  } finally {
    await new Promise((resolve) => echo.server.close(resolve));
    await new Promise((resolve) => loopbackEcho.server.close(resolve));
    await new Promise((resolve) => proxy.close(resolve));
  }
});
