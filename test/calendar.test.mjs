/**
 * Calendar 工具的行为测试：自然语言时间、CRUD 往返、忙闲查询、守卫与错误翻译。
 *
 * 全部请求打到本地模拟的 Google 服务，因此不需要真实凭据。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHarness } from './harness.mjs';

/** 每个用例独立起一套环境，避免状态串扰。 */
async function withHarness(options, fn) {
  const harness = await createHarness(options);
  try {
    await fn(harness);
  } finally {
    await harness.close();
  }
}

test('gcal_list_calendars 返回日历列表并使用刷新后的令牌', async () => {
  await withHarness({}, async (h) => {
    const result = await h.call('gcal_list_calendars', {});
    assert.match(result.text, /主日历/);
    assert.match(result.text, /工作/);
    assert.equal(result.data.total, 2);
    // 预置的令牌只有 refresh_token，因此第一次调用必须先刷新。
    const refreshes = h.mock.state.tokenRequests.filter((entry) => entry.grant === 'refresh_token');
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0].form.refresh_token, 'rt-seed');
  });
});

test('gcal_create_event 解析自然语言时间并创建成功', async () => {
  await withHarness({}, async (h) => {
    const result = await h.call('gcal_create_event', {
      summary: '项目评审',
      start: '明天下午3点',
      location: '3 号会议室',
    });
    const created = [...h.mock.state.events.get('primary').values()][0];
    assert.equal(created.summary, '项目评审');
    assert.equal(created.start.dateTime, '2026-10-06T15:00:00+08:00');
    // 只给 start 时默认 60 分钟。
    assert.equal(created.end.dateTime, '2026-10-06T16:00:00+08:00');
    assert.equal(created.location, '3 号会议室');
    assert.match(result.text, /已创建日程/);
    assert.equal(result.data._calendarId, 'primary');
  });
});

test('gcal_create_event 的 end 只给时刻时落到开始当天', async () => {
  await withHarness({}, async (h) => {
    await h.call('gcal_create_event', { summary: '面谈', start: '明天下午3点', end: '16:30' });
    const created = [...h.mock.state.events.get('primary').values()][0];
    assert.equal(created.start.dateTime, '2026-10-06T15:00:00+08:00');
    assert.equal(created.end.dateTime, '2026-10-06T16:30:00+08:00');
  });
});

test('gcal_create_event 支持全天事件与多天', async () => {
  await withHarness({}, async (h) => {
    await h.call('gcal_create_event', { summary: '出差', start: '2026-10-12', days: 3 });
    const created = [...h.mock.state.events.get('primary').values()][0];
    assert.deepEqual(created.start, { date: '2026-10-12' });
    assert.deepEqual(created.end, { date: '2026-10-15' });
  });
  await withHarness({}, async (h) => {
    // 只给日期时自动识别为全天。
    await h.call('gcal_create_event', { summary: '年会', start: '明天' });
    const created = [...h.mock.state.events.get('primary').values()][0];
    assert.deepEqual(created.start, { date: '2026-10-06' });
    assert.deepEqual(created.end, { date: '2026-10-07' });
  });
});

test('gcal_create_event 拒绝结束早于开始', async () => {
  await withHarness({}, async (h) => {
    await assert.rejects(
      () => h.call('gcal_create_event', { summary: '错误', start: '明天下午3点', end: '明天下午2点' }),
      /结束时间必须晚于开始时间/,
    );
    assert.equal(h.mock.state.events.get('primary').size, 0);
  });
});

test('gcal_create_event 生成重复规则与提醒', async () => {
  await withHarness({}, async (h) => {
    await h.call('gcal_create_event', {
      summary: '周会',
      start: '明天 10:00',
      durationMinutes: 30,
      repeat: 'weekly',
      repeatCount: 4,
      reminderMinutes: [10, 60],
    });
    const created = [...h.mock.state.events.get('primary').values()][0];
    // 2026-10-06 是周二。
    assert.deepEqual(created.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4']);
    assert.deepEqual(created.reminders, {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 10 }, { method: 'popup', minutes: 60 }],
    });
    assert.equal(created.end.dateTime, '2026-10-06T10:30:00+08:00');
  });
});

test('gcal_create_event 支持 dryRun 且不落库', async () => {
  await withHarness({}, async (h) => {
    const result = await h.call('gcal_create_event', { summary: '预览', start: '明天下午3点', dryRun: true });
    assert.match(result.text, /\[预览\]/);
    assert.equal(result.data.dryRun, true);
    assert.equal(h.mock.state.events.get('primary').size, 0);
  });
});

test('gcal_create_event 传 attendees 时默认发送邀请', async () => {
  await withHarness({}, async (h) => {
    await h.call('gcal_create_event', {
      summary: '评审',
      start: '明天下午3点',
      attendees: ['张总 <zhang@example.com>', 'li@example.com'],
    });
    const created = [...h.mock.state.events.get('primary').values()][0];
    assert.deepEqual(created.attendees, [
      { email: 'zhang@example.com', displayName: '张总' },
      { email: 'li@example.com' },
    ]);
    const insertRequest = h.mock.state.requests.find((entry) => entry.method === 'POST' && entry.path.endsWith('/events'));
    assert.match(insertRequest.query, /sendUpdates=all/);
  });
});

test('gcal_list_events 支持关键词、时间范围与跨日历合并', async () => {
  await withHarness({}, async (h) => {
    h.mock.putEvent('primary', {
      summary: '牙医',
      start: { dateTime: '2026-10-06T09:00:00+08:00' },
      end: { dateTime: '2026-10-06T10:00:00+08:00' },
    });
    h.mock.putEvent('work@example.com', {
      summary: '客户会议',
      start: { dateTime: '2026-10-06T14:00:00+08:00' },
      end: { dateTime: '2026-10-06T15:00:00+08:00' },
    });
    h.mock.putEvent('primary', {
      summary: '下周的无关日程',
      start: { dateTime: '2026-10-20T09:00:00+08:00' },
      end: { dateTime: '2026-10-20T10:00:00+08:00' },
    });

    const today = await h.call('gcal_list_events', { timeMin: '今天', timeMax: '今天' });
    assert.equal(today.data.events.length, 0);
    assert.match(today.text, /没有找到日程/);

    const merged = await h.call('gcal_list_events', { calendarId: 'all', timeMin: '明天', timeMax: '明天' });
    assert.equal(merged.data.events.length, 2);
    // 按时间排序：09:00 的牙医在前。
    assert.equal(merged.data.events[0].summary, '牙医');
    assert.equal(merged.data.events[1].summary, '客户会议');
    assert.match(merged.text, /已合并查询 2 个日历/);

    const searched = await h.call('gcal_list_events', { calendarId: 'all', timeMin: '明天', timeMax: '明天', query: '客户' });
    assert.equal(searched.data.events.length, 1);
    assert.equal(searched.data.events[0].summary, '客户会议');
  });
});

test('gcal_list_events 未给范围时默认未来 7 天', async () => {
  await withHarness({}, async (h) => {
    h.mock.putEvent('primary', {
      summary: '三天后',
      start: { dateTime: '2026-10-08T09:00:00+08:00' },
      end: { dateTime: '2026-10-08T10:00:00+08:00' },
    });
    h.mock.putEvent('primary', {
      summary: '一个月后',
      start: { dateTime: '2026-11-08T09:00:00+08:00' },
      end: { dateTime: '2026-11-08T10:00:00+08:00' },
    });
    const result = await h.call('gcal_list_events', {});
    assert.equal(result.data.defaultedRange, true);
    assert.equal(result.data.events.length, 1);
    assert.equal(result.data.events[0].summary, '三天后');
  });
});

test('gcal_update_event 支持部分字段与参与者增量调整', async () => {
  await withHarness({}, async (h) => {
    await h.call('gcal_create_event', {
      summary: '初稿',
      start: '明天下午3点',
      attendees: ['a@example.com', 'b@example.com'],
    });
    const eventId = [...h.mock.state.events.get('primary').keys()][0];

    const updated = await h.call('gcal_update_event', {
      eventId,
      summary: '终稿',
      location: '线上',
      removeAttendees: ['a@example.com'],
      addAttendees: ['c@example.com'],
    });
    assert.equal(updated.data.summary, '终稿');
    assert.equal(updated.data.location, '线上');
    assert.deepEqual(updated.data.attendees.map((item) => item.email), ['b@example.com', 'c@example.com']);
    // 未提交的字段保持不变。
    assert.equal(updated.data.start.dateTime, '2026-10-06T15:00:00+08:00');
  });
});

test('gcal_update_event 无字段时报错', async () => {
  await withHarness({}, async (h) => {
    await h.call('gcal_create_event', { summary: 'x', start: '明天下午3点' });
    const eventId = [...h.mock.state.events.get('primary').keys()][0];
    await assert.rejects(() => h.call('gcal_update_event', { eventId }), /没有检测到任何要修改的字段/);
  });
});

test('gcal_delete_event 需要二次确认', async () => {
  await withHarness({}, async (h) => {
    await h.call('gcal_create_event', { summary: '待删', start: '明天下午3点' });
    const eventId = [...h.mock.state.events.get('primary').keys()][0];
    await assert.rejects(() => h.call('gcal_delete_event', { eventId }), /需要二次确认/);
    assert.equal(h.mock.state.events.get('primary').size, 1);
    const result = await h.call('gcal_delete_event', { eventId, confirm: true });
    assert.match(result.text, /已删除日程/);
    assert.equal(h.mock.state.events.get('primary').size, 0);
  });
});

test('gcal_quick_add 与 gcal_move_event', async () => {
  await withHarness({}, async (h) => {
    const quick = await h.call('gcal_quick_add', { text: '周五下午2点 项目评审 会议室A' });
    assert.match(quick.text, /已按自然语言创建日程/);
    const eventId = quick.data.id;

    const moved = await h.call('gcal_move_event', { eventId, destination: 'work@example.com' });
    assert.match(moved.text, /已移动日程/);
    // 回归：move 响应里可能带源日历那份「已取消」墓碑的 status，必须回读目标日历
    // 才能给出正确结论 —— 否则确认文案会自相矛盾地写成「已移动……（已取消）」。
    assert.match(moved.text, /状态：正常/);
    assert.doesNotMatch(moved.text, /已取消/);
    assert.equal(moved.data.status, 'confirmed');
    assert.equal(h.mock.state.events.get('primary').size, 0);
    assert.equal(h.mock.state.events.get('work@example.com').size, 1);
  });
});

test('gcal_get_event 返回详情与参与者状态', async () => {
  await withHarness({}, async (h) => {
    h.mock.putEvent('primary', {
      summary: '评审',
      location: '会议室',
      description: '准备材料',
      start: { dateTime: '2026-10-06T15:00:00+08:00' },
      end: { dateTime: '2026-10-06T16:00:00+08:00' },
      attendees: [{ email: 'me@example.com', self: true, responseStatus: 'needsAction' }],
      htmlLink: 'https://calendar.google.com/event?eid=abc',
    });
    const result = await h.call('gcal_get_event', { eventId: 'evt0001' });
    assert.match(result.text, /标题：评审/);
    assert.match(result.text, /地点：会议室/);
    assert.match(result.text, /描述：准备材料/);
    assert.match(result.text, /待回复/);
  });
});

test('gcal_respond_to_invite 更新自己的参与状态', async () => {
  await withHarness({}, async (h) => {
    h.mock.putEvent('primary', {
      id: 'evt-invite',
      summary: '邀请',
      start: { dateTime: '2026-10-06T15:00:00+08:00' },
      end: { dateTime: '2026-10-06T16:00:00+08:00' },
      attendees: [
        { email: 'me@example.com', self: true, responseStatus: 'needsAction' },
        { email: 'other@example.com', responseStatus: 'accepted' },
      ],
    });
    const result = await h.call('gcal_respond_to_invite', { eventId: 'evt-invite', response: 'accepted' });
    assert.match(result.text, /已接受日程/);
    const stored = h.mock.state.events.get('primary').get('evt-invite');
    assert.equal(stored.attendees.find((item) => item.self).responseStatus, 'accepted');
    // 其它参与者不受影响。
    assert.equal(stored.attendees.find((item) => !item.self).responseStatus, 'accepted');
  });
});

test('gcal_find_free_slots 在忙碌日程之间找出空闲时段', async () => {
  await withHarness({}, async (h) => {
    h.mock.putEvent('primary', {
      summary: '早会',
      start: { dateTime: '2026-10-06T09:00:00+08:00' },
      end: { dateTime: '2026-10-06T10:00:00+08:00' },
    });
    h.mock.putEvent('work@example.com', {
      summary: '午餐会',
      start: { dateTime: '2026-10-06T12:00:00+08:00' },
      end: { dateTime: '2026-10-06T13:00:00+08:00' },
    });
    const result = await h.call('gcal_find_free_slots', {
      timeMin: '2026-10-06',
      timeMax: '2026-10-06',
      calendars: ['primary', 'work@example.com'],
      durationMinutes: 60,
      dayStart: '09:00',
      dayEnd: '13:00',
      maxSlots: 5,
    });
    // 09:00-10:00 忙、12:00-13:00 忙 => 10:00-11:00 与 11:00-12:00 可用（每段 60 分钟）。
    assert.equal(result.data.slots.length, 2);
    assert.equal(result.data.slots[0].start, '2026-10-06T10:00:00+08:00');
    assert.equal(result.data.slots[1].start, '2026-10-06T11:00:00+08:00');
  });
});

test('gcal_find_free_slots 周末默认跳过', async () => {
  await withHarness({}, async (h) => {
    // 2026-10-10 是周六。
    const skipped = await h.call('gcal_find_free_slots', { timeMin: '2026-10-10', timeMax: '2026-10-10', durationMinutes: 30 });
    assert.equal(skipped.data.slots.length, 0);
    const included = await h.call('gcal_find_free_slots', { timeMin: '2026-10-10', timeMax: '2026-10-10', durationMinutes: 30, includeWeekends: true });
    assert.ok(included.data.slots.length > 0);
  });
});

test('只读模式拒绝一切写入', async () => {
  await withHarness({ config: { readOnly: true } }, async (h) => {
    await assert.rejects(() => h.call('gcal_create_event', { summary: 'x', start: '明天' }), /只读模式/);
    await assert.rejects(() => h.call('gcal_delete_event', { eventId: 'x', confirm: true }), /只读模式/);
    // 读取仍然可用。
    const result = await h.call('gcal_list_calendars', {});
    assert.equal(result.data.total, 2);
  });
});

test('requireConfirmForWrites 打开后所有写入都要确认', async () => {
  await withHarness({ config: { requireConfirmForWrites: true } }, async (h) => {
    await assert.rejects(() => h.call('gcal_create_event', { summary: 'x', start: '明天' }), /需要二次确认/);
    const ok = await h.call('gcal_create_event', { summary: 'x', start: '明天', confirm: true });
    assert.match(ok.text, /已创建日程/);
  });
});

test('401 会自动刷新令牌并重试一次', async () => {
  await withHarness({}, async (h) => {
    // 让本地缓存一个「看起来有效」但服务端已失效的 access token。
    await h.auth.saveToken({ access_token: 'at-seed', expires_at: h.now + 3600_000, refresh_token: 'rt-seed' });
    h.mock.state.issuedAccessTokens.delete('at-seed');
    const result = await h.call('gcal_list_calendars', {});
    assert.equal(result.data.total, 2);
    const refreshes = h.mock.state.tokenRequests.filter((entry) => entry.grant === 'refresh_token');
    assert.equal(refreshes.length, 1);
  });
});

test('Google 错误被翻译成可读中文', async () => {
  await withHarness({}, async (h) => {
    h.mock.failOnce('/calendars/primary/events', { status: 403, message: 'Insufficient Permission', reason: 'insufficientPermissions' });
    await assert.rejects(
      () => h.call('gcal_create_event', { summary: 'x', start: '明天下午3点' }),
      (error) => {
        assert.match(error.message, /Insufficient Permission/);
        assert.match(error.message, /原因：insufficientPermissions/);
        assert.match(error.message, /无权限或超出配额/);
        return true;
      },
    );
  });
});

test('refresh token 失效时给出重新授权提示', async () => {
  await withHarness({}, async (h) => {
    await h.auth.saveToken({ refresh_token: 'rt-revoked' });
    await assert.rejects(
      () => h.call('gcal_list_calendars', {}),
      /invalid_grant/,
    );
    await assert.rejects(
      () => h.call('gcal_list_calendars', {}),
      /refresh token 已失效/,
    );
  });
});

test('没有令牌时给出授权指引', async () => {
  await withHarness({ withToken: false }, async (h) => {
    await assert.rejects(() => h.call('gcal_list_calendars', {}), /尚未完成 Google 授权/);
  });
});

test('日历的增删改查', async () => {
  await withHarness({}, async (h) => {
    const created = await h.call('gcal_create_calendar', { summary: '读书', timeZone: 'Asia/Shanghai' });
    assert.equal(created.data.summary, '读书');
    const calendarId = created.data.id;

    const updated = await h.call('gcal_update_calendar', { calendarId, summary: '读书计划' });
    assert.equal(updated.data.summary, '读书计划');

    await assert.rejects(() => h.call('gcal_delete_calendar', { calendarId }), /需要二次确认/);
    const deleted = await h.call('gcal_delete_calendar', { calendarId, confirm: true });
    assert.match(deleted.text, /已删除日历/);
    assert.equal(h.mock.state.calendars.has(calendarId), false);

    await assert.rejects(() => h.call('gcal_delete_calendar', { calendarId: 'primary', confirm: true }), /不能删除主日历/);
  });
});

test('未配置 OAuth 客户端时 google_auth_begin 给出配置指引', async () => {
  await withHarness({ config: { clientId: undefined, clientSecret: undefined } }, async (h) => {
    await assert.rejects(() => h.call('google_auth_begin', {}), /尚未配置 OAuth 客户端凭据/);
  });
});
