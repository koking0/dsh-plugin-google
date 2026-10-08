/**
 * Google Calendar 工具集：日历、事件、忙闲查询、邀请回复。
 *
 * 时间参数全部支持自然语言（「明天下午3点」「下周一 10:00」「+2h」），由 `lib/time.js`
 * 在配置时区内解析；需要精确定位时也可以直接给 RFC 3339 时间戳。
 *
 * @module dsh-plugin-google/lib/tools/calendar
 */

import { randomUUID } from 'node:crypto';

import { ToolInputError } from '../errors.js';
import {
  formatCalendarLine,
  formatEventDetail,
  formatEventLine,
} from '../format.js';
import {
  addDays,
  formatDateTimeLabel,
  parseBoundary,
  parseDurationMinutes,
  parseTimeToken,
  parseWhen,
  partsInZone,
  toDateString,
  toRfc3339,
} from '../time.js';
import {
  boolParam,
  clampLimit,
  CONFIRM_PARAM,
  enumParam,
  intListParam,
  intParam,
  normalizeStringList,
  optionalString,
  requireString,
  stringListParam,
  stringParam,
  toolSpec,
} from './common.js';

/** `sendUpdates` 的取值。 */
const SEND_UPDATES = ['all', 'externalOnly', 'none'];

/**
 * 解析 `Name <email>` 或纯邮箱。
 * @param {string} value - 参与者表达。
 * @returns {{email:string, displayName?:string}} 参与者对象。
 */
export function parseAttendee(value) {
  const text = String(value ?? '').trim();
  const angled = /^(.*?)[<＜]([^>＞]+)[>＞]\s*$/.exec(text);
  if (angled) {
    const name = angled[1].trim().replace(/^["']|["']$/g, '');
    return { email: angled[2].trim(), ...(name ? { displayName: name } : {}) };
  }
  return { email: text };
}

/**
 * 创建 Calendar 工具。
 *
 * @param {object} deps - 插件依赖。
 * @returns {object[]} 工具规格数组。
 */
export function createCalendarTools(deps) {
  const { calendar, config, guard, logger, now } = deps;
  const tz = deps.timeZone;

  /** 默认日历 ID。 */
  const calendarIdOf = (args) => optionalString(args, 'calendarId') ?? config.defaultCalendarId ?? 'primary';

  /** 时区参数。 */
  const timeZoneOf = (args) => optionalString(args, 'timeZone') ?? tz;

  /** 一次调用内的「当前时刻」，保证同一次工具调用内部时间一致。 */
  const clock = () => (typeof now === 'function' ? now() : Date.now());

  /** 根据是否通知参与者推断 sendUpdates。 */
  function sendUpdatesOf(args, attendees) {
    const explicit = optionalString(args, 'sendUpdates');
    if (explicit) return explicit;
    return Array.isArray(attendees) && attendees.length > 0 ? 'all' : 'none';
  }

  /**
   * 构造事件的 start/end。
   *
   * - 定时事件：`start` 与 `end` 都要求带时刻；只给 `start` 时按 `durationMinutes` 推算。
   * - 全天事件：只给 `start` 时按 `days`（默认 1 天）推算；`end` 采用 Google 语义（不含当日）。
   */
  function buildEventTime(args, { requireStart = true } = {}) {
    const zone = timeZoneOf(args);
    const startRaw = optionalString(args, 'start');
    if (!startRaw) {
      if (requireStart) throw new ToolInputError('缺少 start 参数。可以写「明天下午3点」「2026-10-06T15:00:00+08:00」或「2026-10-06」。');
      return undefined;
    }
    const startParsed = parseWhen(startRaw, { timeZone: zone, now: clock(), edge: 'exact' });
    const allDay = args?.allDay === true || startParsed.kind === 'date';

    if (allDay) {
      const startDate = startParsed.kind === 'date' ? startParsed.date : toDateString(partsInZone(startParsed.epochMs, zone));
      const endRaw = optionalString(args, 'end');
      if (endRaw) {
        const endParsed = parseWhen(endRaw, { timeZone: zone, now: clock(), edge: 'exact' });
        const endDate = endParsed.kind === 'date' ? endParsed.date : toDateString(partsInZone(endParsed.epochMs, zone));
        if (endDate <= startDate) {
          throw new ToolInputError(
            `全天事件的结束日期必须晚于开始日期（start=${startDate}, end=${endDate}）。`
            + '注意 Google 的 end 不含当日：要创建 10-06 至 10-07 两天，end 请传 2026-10-08；'
            + '或改用 days 参数指定天数。',
          );
        }
        return { start: { date: startDate }, end: { date: endDate }, allDay: true, assumed: startParsed.assumed };
      }
      const days = Number.isFinite(Number(args?.days)) && Number(args.days) > 0 ? Math.floor(Number(args.days)) : 1;
      return { start: { date: startDate }, end: { date: addDays(startDate, days) }, allDay: true, assumed: startParsed.assumed };
    }

    const endRaw = optionalString(args, 'end');
    let endEpoch;
    if (endRaw) {
      const endParsed = parseWhen(endRaw, { timeZone: zone, now: clock(), edge: 'exact' });
      if (endParsed.kind === 'date') {
        throw new ToolInputError(
          `定时事件的 end 必须包含具体时刻（收到的是纯日期「${endRaw}」）。`
          + '可以写「16:00」「明天下午4点」，或改用 durationMinutes 指定时长。',
        );
      }
      endEpoch = endParsed.epochMs;
      // 「明天下午3点到4点」这类只给时刻的结束时间：落到开始时间所在的那一天。
      // 若 end 自带日期语境（「明天下午2点」）则不做顺延，让下面的校验如实报错。
      const clockPart = parseTimeToken(endRaw);
      const hasDateContext = /(今天|明天|后天|昨天|前天|大后天|周|星期|礼拜|月|日|号|\d{4}[-/]|today|tomorrow|yesterday|next|last|mon|tue|wed|thu|fri|sat|sun)/i.test(endRaw);
      if (endEpoch <= startParsed.epochMs && clockPart && !hasDateContext) {
        const startParts = partsInZone(startParsed.epochMs, zone);
        endEpoch = deps.epochFromParts({ ...startParts, ...clockPart, second: 0 }, zone);
      }
    } else {
      const minutes = parseDurationMinutes(args?.durationMinutes) ?? config.defaultEventMinutes ?? 60;
      endEpoch = startParsed.epochMs + minutes * 60000;
    }
    if (endEpoch <= startParsed.epochMs) {
      throw new ToolInputError(
        `事件的结束时间必须晚于开始时间（start=${formatDateTimeLabel(startParsed.epochMs, zone)}，`
        + `end=${formatDateTimeLabel(endEpoch, zone)}）。`,
      );
    }
    return {
      start: { dateTime: toRfc3339(startParsed.epochMs, zone), timeZone: zone },
      end: { dateTime: toRfc3339(endEpoch, zone), timeZone: zone },
      allDay: false,
      assumed: startParsed.assumed,
      startEpoch: startParsed.epochMs,
      endEpoch,
    };
  }

  /** 由 repeat 快捷方式或 recurrence 生成重复规则。 */
  function buildRecurrence(args, timeRange) {
    const explicit = normalizeStringList(args?.recurrence);
    if (explicit.length > 0) return explicit;
    const repeat = optionalString(args, 'repeat');
    if (!repeat || repeat === 'none') return undefined;

    const zone = timeZoneOf(args);
    // 优先用调用方给出的基准时刻（更新场景取原事件时间），否则回退到 start / 今天。
    const startEpoch = timeRange?.startEpoch
      ?? parseBoundary(optionalString(args, 'start') ?? 'today', { timeZone: zone, now: clock(), edge: 'start' });
    const parts = partsInZone(startEpoch, zone);
    const freq = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY', weekdays: 'WEEKLY' }[repeat];
    if (!freq) {
      throw new ToolInputError(`不支持的 repeat 取值「${repeat}」。可用：none / daily / weekdays / weekly / monthly / yearly。`);
    }
    const clauses = [`FREQ=${freq}`];
    if (repeat === 'weekdays') {
      clauses.push('BYDAY=MO,TU,WE,TH,FR');
    } else if (repeat === 'weekly') {
      clauses.push(`BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][parts.weekday]}`);
    } else if (repeat === 'monthly') {
      clauses.push(`BYMONTHDAY=${parts.day}`);
    }
    const count = Number(args?.repeatCount);
    if (Number.isFinite(count) && count > 0) {
      clauses.push(`COUNT=${Math.floor(count)}`);
    } else {
      const untilRaw = optionalString(args, 'repeatUntil');
      if (untilRaw) {
        const untilParsed = parseWhen(untilRaw, { timeZone: zone, now: clock(), edge: 'end' });
        const untilEpoch = untilParsed.kind === 'dateTime' ? untilParsed.epochMs : untilParsed.epochMs;
        clauses.push(`UNTIL=${new Date(untilEpoch).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
      }
    }
    return [`RRULE:${clauses.join(';')}`];
  }

  /** 由参数构造 reminders 字段。 */
  function buildReminders(args) {
    if (args?.useDefaultReminders === true) return { useDefault: true };
    const minutes = Array.isArray(args?.reminderMinutes) ? args.reminderMinutes.filter((n) => Number.isFinite(n)) : [];
    if (minutes.length === 0) return undefined;
    return { useDefault: false, overrides: minutes.map((value) => ({ method: 'popup', minutes: Math.max(0, Math.floor(value)) })) };
  }

  /** 构造会议（Google Meet）。 */
  function buildConference(args) {
    if (args?.conference !== true) return undefined;
    return {
      createRequest: {
        requestId: `dsh-${randomUUID()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  /** 会议相关能力需要 conferenceDataVersion=1。 */
  function eventQuery(args, extras = {}) {
    const query = { ...extras };
    if (extras.conferenceDataVersion || args?.conference === true) query.conferenceDataVersion = 1;
    return query;
  }

  /** 读取事件，用于更新/回复前先拿到现状；404 翻译成可读提示。 */
  async function fetchEvent(calendarId, eventId) {
    let event;
    try {
      event = await calendar.getEvent(calendarId, eventId);
    } catch (error) {
      if (error?.status === 404) {
        throw new ToolInputError(
          `未找到事件 ${eventId}（日历 ${calendarId}）。请用 gcal_list_events 确认事件 ID 与所在日历；`
          + '重复日程的实例 ID 与整个系列的 ID 不同，必要时先用返回的 id 再查一次。',
          { status: 404 },
        );
      }
      throw error;
    }
    if (!event) throw new ToolInputError(`未找到事件 ${eventId}（日历 ${calendarId}）。`);
    return event;
  }

  return [
    toolSpec({
      name: 'gcal_list_calendars',
      title: '列出 Google 日历',
      kind: 'read',
      description: '列出当前账号可见的所有 Google 日历（含主日历、订阅日历、共享日历），'
        + '返回每个日历的 ID、名称、权限与颜色。其它工具里的 calendarId 就用这里的 ID。',
      parameters: {
        maxResults: intParam('最多返回多少个日历（默认 100）'),
        showHidden: boolParam('是否包含已隐藏的日历（默认 false）'),
        showDeleted: boolParam('是否包含已删除的日历（默认 false）'),
      },
      async run(args) {
        const response = await calendar.listCalendars({
          maxResults: clampLimit(args?.maxResults, 100, 250),
          showHidden: args?.showHidden === true ? true : undefined,
          showDeleted: args?.showDeleted === true ? true : undefined,
        });
        const items = response?.items ?? [];
        const lines = items.map((item) => formatCalendarLine(item));
        const text = items.length === 0
          ? '没有查到可用的日历。'
          : `共 ${items.length} 个日历（★ 为主日历）：\n${lines.join('\n')}`;
        return { text, data: { total: items.length, calendars: items } };
      },
    }),

    toolSpec({
      name: 'gcal_create_calendar',
      title: '新建 Google 日历',
      kind: 'write',
      description: '创建一个新的次级日历（例如「工作」「家庭」），返回其 ID。主日历无法通过 API 创建。',
      parameters: {
        summary: stringParam('日历名称，例如「工作」', true),
        description: stringParam('日历描述'),
        location: stringParam('日历关联的地点'),
        timeZone: stringParam('日历默认时区，例如 Asia/Shanghai；不填则用插件配置的时区'),
      },
      async run(args) {
        guard.assertWrite(args, '新建日历');
        const body = {
          summary: requireString(args, 'summary'),
          timeZone: timeZoneOf(args),
        };
        if (args?.description) body.description = String(args.description);
        if (args?.location) body.location = String(args.location);
        const created = await calendar.createCalendar(body);
        return {
          text: `已创建日历「${created.summary}」\nid：${created.id}\n时区：${created.timeZone ?? '未设置'}`,
          data: created,
        };
      },
    }),

    toolSpec({
      name: 'gcal_update_calendar',
      title: '修改 Google 日历',
      kind: 'write',
      description: '修改日历的名称、描述、地点或默认时区。只提交给出的字段，未给出的保持不变。'
        + '注意日历 ID 不会随名称改变，其它工具仍用同一个 ID 引用它。',
      parameters: {
        calendarId: stringParam('日历 ID；不填则用默认日历', true),
        summary: stringParam('新的日历名称'),
        description: stringParam('新的描述'),
        location: stringParam('新的地点'),
        timeZone: stringParam('新的默认时区，例如 Asia/Shanghai'),
      },
      async run(args) {
        guard.assertWrite(args, '修改日历');
        const body = {};
        if (args?.summary !== undefined) body.summary = String(args.summary);
        if (args?.description !== undefined) body.description = String(args.description);
        if (args?.location !== undefined) body.location = String(args.location);
        if (timeZoneOf(args)) body.timeZone = timeZoneOf(args);
        if (Object.keys(body).length === 0) {
          throw new ToolInputError('没有需要修改的字段。请至少提供 summary / description / location / timeZone 之一。');
        }
        const updated = await calendar.updateCalendar(calendarIdOf(args), body, { patch: true });
        return {
          text: `已更新日历「${updated.summary}」（id：${updated.id}）\n变更字段：${Object.keys(body).join('、')}`,
          data: updated,
        };
      },
    }),

    toolSpec({
      name: 'gcal_delete_calendar',
      title: '删除 Google 日历',
      kind: 'danger',
      description: '永久删除一个次级日历及其中的全部事件。主日历无法删除。这是不可恢复的操作，'
        + '必须先取得用户明确同意再传 confirm: true。',
      parameters: {
        calendarId: stringParam('要删除的日历 ID（必填，不允许删除主日历）', true),
        confirm: CONFIRM_PARAM,
      },
      async run(args) {
        guard.assertWritable('删除日历');
        const calendarId = requireString(args, 'calendarId');
        if (calendarId === 'primary') throw new ToolInputError('不能删除主日历（primary）。');
        guard.confirm(args, { action: `删除日历 ${calendarId}`, always: true });
        await calendar.deleteCalendar(calendarId);
        return { text: `已删除日历 ${calendarId}。`, data: { calendarId, deleted: true } };
      },
    }),

    toolSpec({
      name: 'gcal_list_events',
      title: '查询日程',
      kind: 'read',
      description: '查询指定时间范围内的日程。timeMin/timeMax 支持自然语言（「今天」「本周」「明天下午3点」「+7d」）；'
        + '都不填时默认查询「现在起 7 天内」的日程。calendarId 传 all 可一次性查询所有日历并按时间合并排序，'
        + '适合「未来有什么安排」这类问题。',
      parameters: {
        calendarId: stringParam('日历 ID；不填用主日历；传 all 表示所有日历合并查询', false),
        timeMin: stringParam('起始时间，含。例如「今天」「2026-10-06T00:00:00+08:00」'),
        timeMax: stringParam('结束时间，不含。例如「本周」「+7d」'),
        query: stringParam('按关键词全文搜索（对应 Google 的 q 参数：标题、描述、地点、参与者）'),
        maxResults: intParam('每个日历最多返回多少条（默认 50，上限 250）'),
        singleEvents: boolParam('是否把重复事件展开为单个实例（默认 true，强烈建议保持 true）'),
        orderBy: enumParam(['startTime', 'updated'], '排序方式；展开重复事件时只能用 startTime'),
        showDeleted: boolParam('是否包含已取消的事件（默认 false）'),
        pageToken: stringParam('分页令牌，用于读取下一页'),
        timeZone: stringParam('解释自然语言时间所用的时区；不填则用插件配置的时区'),
      },
      async run(args) {
        const zone = timeZoneOf(args);
        const current = clock();
        const singleEvents = args?.singleEvents !== false;
        let timeMin = optionalString(args, 'timeMin');
        let timeMax = optionalString(args, 'timeMax');
        let defaultedRange = false;
        if (!timeMin && !timeMax) {
          timeMin = toRfc3339(current, zone);
          timeMax = toRfc3339(current + 7 * 86400000, zone);
          defaultedRange = true;
        } else {
          timeMin = timeMin ? toRfc3339(parseBoundary(timeMin, { timeZone: zone, now: current, edge: 'start' }), zone) : undefined;
          timeMax = timeMax ? toRfc3339(parseBoundary(timeMax, { timeZone: zone, now: current, edge: 'end' }), zone) : undefined;
        }

        const maxResults = clampLimit(args?.maxResults, 50, 250);
        const calendarId = calendarIdOf(args);
        const baseQuery = {
          timeMin,
          timeMax,
          q: optionalString(args, 'query'),
          maxResults,
          singleEvents: singleEvents || undefined,
          orderBy: singleEvents ? (optionalString(args, 'orderBy') ?? 'startTime') : optionalString(args, 'orderBy'),
          showDeleted: args?.showDeleted === true ? true : undefined,
          pageToken: optionalString(args, 'pageToken'),
          timeZone: zone,
        };

        let entries = [];
        let calendarsUsed = [];
        let nextPageToken;
        if (calendarId === 'all' || calendarId === '*') {
          const list = await calendar.listCalendars({ maxResults: 250, minAccessRole: undefined });
          const usable = (list?.items ?? []).filter((item) => item.deleted !== true && item.hidden !== true);
          calendarsUsed = usable.map((item) => ({ id: item.id, summary: item.summaryOverride ?? item.summary }));
          for (const item of usable) {
            try {
              const response = await calendar.listEvents(item.id, { ...baseQuery, pageToken: undefined });
              for (const event of response?.items ?? []) {
                entries.push({ event, calendarId: item.id, calendarName: item.summaryOverride ?? item.summary });
              }
            } catch (error) {
              logger?.debug?.('[google] 合并查询时跳过一个日历', { calendarId: item.id, message: error?.message });
            }
          }
          entries.sort((a, b) => eventStartEpoch(a.event) - eventStartEpoch(b.event));
          entries = entries.slice(0, maxResults);
        } else {
          const response = await calendar.listEvents(calendarId, baseQuery);
          entries = (response?.items ?? []).map((event) => ({ event, calendarId, calendarName: undefined }));
          nextPageToken = response?.nextPageToken;
        }

        const lines = entries.map((entry) => formatEventLine(entry.event, { timeZone: zone, calendarName: entry.calendarName }));
        const rangeText = `${formatDateTimeLabel(Date.parse(timeMin), zone)} 至 ${formatDateTimeLabel(Date.parse(timeMax), zone)}`;
        const head = entries.length === 0
          ? `在 ${rangeText} 内没有找到日程。`
          : `${rangeText} 内共 ${entries.length} 条日程${defaultedRange ? '（未指定范围，默认未来 7 天）' : ''}：`;
        const text = [
          head,
          ...lines,
          calendarId === 'all' ? `\n已合并查询 ${calendarsUsed.length} 个日历。` : '',
        ].filter(Boolean).join('\n');
        return {
          text,
          data: {
            timeMin,
            timeMax,
            timeZone: zone,
            defaultedRange,
            calendarId,
            calendars: calendarsUsed.length > 0 ? calendarsUsed : undefined,
            nextPageToken: typeof nextPageToken === 'string' ? nextPageToken : undefined,
            events: entries.map((entry) => ({ ...entry.event, _calendarId: entry.calendarId })),
          },
        };
      },
    }),

    toolSpec({
      name: 'gcal_get_event',
      title: '读取日程详情',
      kind: 'read',
      description: '按 ID 读取单个事件的完整信息：时间、地点、参与者及各自的回复状态、描述、重复规则、会议链接。',
      parameters: {
        eventId: stringParam('事件 ID（可由 gcal_list_events 或 gcal_create_event 获得）', true),
        calendarId: stringParam('事件所在日历 ID；不填用主日历'),
        timeZone: stringParam('展示时间所用的时区；不填用插件配置的时区'),
      },
      async run(args) {
        const zone = timeZoneOf(args);
        const calendarId = calendarIdOf(args);
        const event = await fetchEvent(calendarId, requireString(args, 'eventId'));
        return {
          text: formatEventDetail(event, { timeZone: zone, calendarName: calendarId }),
          data: { ...event, _calendarId: calendarId },
        };
      },
    }),

    toolSpec({
      name: 'gcal_create_event',
      title: '新建日程',
      kind: 'write',
      description: '在 Google 日历中创建日程。start/end 支持自然语言（「明天下午3点到4点」「下周一 10:00」）。'
        + '只给 start 时，定时事件默认时长 60 分钟（可用 durationMinutes 调整），全天事件默认 1 天（可用 days 调整）。'
        + '需要重复时可用 repeat=weekly/daily/... 配合 repeatUntil 或 repeatCount。'
        + '传 attendees 会自动给对方发送邀请；dryRun=true 只预览将要提交的数据、不真正创建。',
      parameters: {
        summary: stringParam('日程标题，例如「项目评审」', true),
        start: stringParam('开始时间。支持「明天下午3点」「2026-10-06T15:00:00+08:00」「2026-10-06（全天）」', true),
        end: stringParam('结束时间。定时事件必须带时刻；全天事件的 end 采用 Google 语义（不含当日），也可改用 days'),
        durationMinutes: intParam('时长（分钟）。未给 end 时使用，默认 60'),
        allDay: boolParam('是否创建全天事件（start 只给日期时会自动识别为全天）'),
        days: intParam('全天事件持续天数（默认 1），仅在未给 end 时生效'),
        description: stringParam('日程描述/备注'),
        location: stringParam('地点，例如「3 号会议室」或地址'),
        attendees: stringListParam('参与者列表，元素为邮箱或「姓名 <邮箱>」。提供后默认会给参与者发送邀请'),
        repeat: enumParam(['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'], '重复方式；weekdays 表示每个工作日'),
        repeatUntil: stringParam('重复截止日期（含），例如「2026-12-31」'),
        repeatCount: intParam('重复次数（与 repeatUntil 二选一）'),
        recurrence: stringListParam('直接提供 RFC 5545 重复规则，例如 RRULE:FREQ=WEEKLY;BYDAY=MO'),
        reminderMinutes: intListParam('提前多少分钟弹窗提醒，可多个，例如 [10, 60]'),
        useDefaultReminders: boolParam('使用日历的默认提醒设置'),
        conference: boolParam('是否创建 Google Meet 视频会议链接'),
        transparency: enumParam(['opaque', 'transparent'], 'opaque 表示占用时间（默认），transparent 表示显示为空闲'),
        calendarId: stringParam('目标日历 ID；不填用主日历'),
        timeZone: stringParam('时区；不填用插件配置的时区'),
        sendUpdates: enumParam(SEND_UPDATES, '是否给参与者发送邀请：all / externalOnly / none（默认有参与者时 all）'),
        dryRun: boolParam('只校验并返回将要提交的数据，不真正创建'),
      },
      async run(args) {
        guard.assertWrite(args, '新建日程');
        const zone = timeZoneOf(args);
        const timeRange = buildEventTime(args, { requireStart: true });
        const attendees = normalizeStringList(args?.attendees).map(parseAttendee);
        const body = {
          summary: requireString(args, 'summary'),
          start: timeRange.start,
          end: timeRange.end,
        };
        if (args?.description) body.description = String(args.description);
        if (args?.location) body.location = String(args.location);
        if (attendees.length > 0) body.attendees = attendees;
        const reminders = buildReminders(args);
        if (reminders) body.reminders = reminders;
        const recurrence = buildRecurrence(args, timeRange);
        if (recurrence) body.recurrence = recurrence;
        if (args?.transparency) body.transparency = String(args.transparency);
        const conferenceData = buildConference(args);
        if (conferenceData) body.conferenceData = conferenceData;

        if (args?.dryRun === true) {
          return {
            text: `[预览] 将创建日程：\n${JSON.stringify(body, null, 2)}\n\n未调用 Google API。确认无误后去掉 dryRun 重新调用。`,
            data: { dryRun: true, calendarId: calendarIdOf(args), body },
          };
        }

        const calendarId = calendarIdOf(args);
        const created = await calendar.createEvent(
          calendarId,
          body,
          eventQuery(args, { sendUpdates: sendUpdatesOf(args, attendees) }),
        );
        const lines = [
          `已创建日程：${created.summary}`,
          `时间：${formatEventDetail(created, { timeZone: zone }).split('\n')[1]?.replace('时间：', '') ?? ''}`,
          `日历：${calendarId}`,
          `id：${created.id}`,
        ];
        if (timeRange.assumed) lines.push('提示：时间包含由时段词推断的默认时刻（例如「今晚」按 19:00），如有出入请用 gcal_update_event 修正。');
        if (created.hangoutLink) lines.push(`Google Meet：${created.hangoutLink}`);
        if (attendees.length > 0) lines.push(`已添加 ${attendees.length} 位参与者。`);
        return { text: lines.join('\n'), data: { ...created, _calendarId: calendarId } };
      },
    }),

    toolSpec({
      name: 'gcal_update_event',
      title: '修改日程',
      kind: 'write',
      description: '修改已有日程。只提交需要改动的字段，未提交的保持不变。'
        + '可以用 addAttendees / removeAttendees 增量调整参与者，或用 attendees 整体替换。'
        + '修改重复日程时，scope=single（默认）只改这一次，scope=all 改整个系列。',
      parameters: {
        eventId: stringParam('要修改的事件 ID', true),
        calendarId: stringParam('事件所在日历 ID；不填用主日历'),
        summary: stringParam('新的标题'),
        start: stringParam('新的开始时间（支持自然语言）'),
        end: stringParam('新的结束时间'),
        durationMinutes: intParam('新的时长（分钟）；给了 start 但没给 end 时使用'),
        allDay: boolParam('是否改为全天事件'),
        description: stringParam('新的描述'),
        location: stringParam('新的地点'),
        attendees: stringListParam('参与者整体替换为这份名单'),
        addAttendees: stringListParam('要新增的参与者（保留原有参与者）'),
        removeAttendees: stringListParam('要移除的参与者（按邮箱匹配）'),
        repeat: enumParam(['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'], '改为按此方式重复；none 表示清除重复规则'),
        repeatUntil: stringParam('重复截止日期（含）'),
        repeatCount: intParam('重复次数'),
        recurrence: stringListParam('直接提供 RFC 5545 重复规则'),
        reminderMinutes: intListParam('改为这些提前提醒（分钟）'),
        useDefaultReminders: boolParam('改为使用日历默认提醒'),
        status: enumParam(['confirmed', 'tentative', 'cancelled'], '事件状态；cancelled 等于取消该日程'),
        transparency: enumParam(['opaque', 'transparent'], '是否占用时间'),
        timeZone: stringParam('时区；不填用插件配置的时区'),
        scope: enumParam(['single', 'all'], '重复日程的修改范围：single 只改本次（默认），all 改整个系列'),
        sendUpdates: enumParam(SEND_UPDATES, '是否通知参与者：all / externalOnly / none（默认 none）'),
      },
      async run(args) {
        guard.assertWrite(args, '修改日程');
        const zone = timeZoneOf(args);
        const calendarId = calendarIdOf(args);
        const eventId = requireString(args, 'eventId');
        const scope = optionalString(args, 'scope') ?? 'single';
        const original = await fetchEvent(calendarId, eventId);
        const targetId = scope === 'all' && original.recurringEventId ? original.recurringEventId : eventId;

        const body = {};
        if (args?.summary !== undefined) body.summary = String(args.summary);
        if (args?.description !== undefined) body.description = String(args.description);
        if (args?.location !== undefined) body.location = String(args.location);
        if (args?.status !== undefined) body.status = String(args.status);
        if (args?.transparency !== undefined) body.transparency = String(args.transparency);

        if (optionalString(args, 'start') || optionalString(args, 'end') || args?.allDay !== undefined || args?.durationMinutes !== undefined) {
          const base = { ...args };
          if (!optionalString(base, 'start')) {
            const existingStart = original.start?.date ?? original.start?.dateTime;
            if (!existingStart) throw new ToolInputError('原事件没有可用的开始时间，请显式提供 start。');
            base.start = existingStart;
          }
          const timeRange = buildEventTime(base, { requireStart: true });
          body.start = timeRange.start;
          body.end = timeRange.end;
        }

        if (args?.attendees !== undefined) {
          body.attendees = normalizeStringList(args.attendees).map(parseAttendee);
        } else if (args?.addAttendees !== undefined || args?.removeAttendees !== undefined) {
          const current = Array.isArray(original.attendees) ? original.attendees : [];
          const removeSet = new Set(normalizeStringList(args?.removeAttendees).map((item) => item.toLowerCase()));
          const kept = current.filter((item) => !removeSet.has(String(item.email ?? '').toLowerCase()));
          const seen = new Set(kept.map((item) => String(item.email ?? '').toLowerCase()));
          for (const raw of normalizeStringList(args?.addAttendees)) {
            const parsed = parseAttendee(raw);
            if (seen.has(parsed.email.toLowerCase())) continue;
            seen.add(parsed.email.toLowerCase());
            kept.push(parsed);
          }
          body.attendees = kept;
        }

        const reminders = buildReminders(args);
        if (reminders) body.reminders = reminders;
        if (optionalString(args, 'repeat') === 'none' && !optionalString(args, 'recurrence')) {
          body.recurrence = [];
        } else {
          // 基于原事件的开始时间推导 BYDAY / BYMONTHDAY，避免改错重复规则。
          const originalStart = optionalString(args, 'start') ?? original.start?.dateTime ?? original.start?.date;
          const baseEpoch = originalStart
            ? parseBoundary(originalStart, { timeZone: zone, now: clock(), edge: 'start' })
            : undefined;
          const recurrence = buildRecurrence(args, baseEpoch ? { startEpoch: baseEpoch } : undefined);
          if (recurrence) body.recurrence = recurrence;
        }

        if (Object.keys(body).length === 0) {
          throw new ToolInputError('没有检测到任何要修改的字段。');
        }
        const updated = await calendar.patchEvent(
          calendarId,
          targetId,
          body,
          eventQuery(args, { sendUpdates: sendUpdatesOf(args, body.attendees) }),
        );
        const lines = [
          `已更新日程：${updated?.summary ?? '(无标题)'}`,
          `时间：${formatEventLine(updated, { timeZone: zone })}`,
          scope === 'all' ? '修改范围：整个重复系列' : '修改范围：单次',
        ];
        return { text: lines.join('\n'), data: { ...updated, _calendarId: calendarId } };
      },
    }),

    toolSpec({
      name: 'gcal_delete_event',
      title: '删除日程',
      kind: 'danger',
      description: '删除日程。这是不可恢复的操作，必须先向用户确认再传 confirm: true。'
        + '删除重复日程时，scope=single（默认）只删除这一次，scope=all 删除整个系列。',
      parameters: {
        eventId: stringParam('要删除的事件 ID', true),
        calendarId: stringParam('事件所在日历 ID；不填用主日历'),
        scope: enumParam(['single', 'all'], '重复日程的删除范围：single 只删本次（默认），all 删整个系列'),
        sendUpdates: enumParam(SEND_UPDATES, '是否通知参与者取消：all / externalOnly / none（默认 none）'),
        confirm: CONFIRM_PARAM,
      },
      async run(args) {
        guard.assertWritable('删除日程');
        const calendarId = calendarIdOf(args);
        const eventId = requireString(args, 'eventId');
        guard.confirm(args, { action: `删除日程 ${eventId}`, always: true });
        const scope = optionalString(args, 'scope') ?? 'single';
        let targetId = eventId;
        if (scope === 'all') {
          const original = await fetchEvent(calendarId, eventId);
          targetId = original.recurringEventId ?? eventId;
        }
        await calendar.deleteEvent(calendarId, targetId, { sendUpdates: optionalString(args, 'sendUpdates') ?? 'none' });
        return {
          text: `已删除日程（日历 ${calendarId}，id ${targetId}${scope === 'all' ? '，整个重复系列' : ''}）。`,
          data: { calendarId, eventId: targetId, scope },
        };
      },
    }),

    toolSpec({
      name: 'gcal_quick_add',
      title: '自然语言快速建日程',
      kind: 'write',
      description: '把一句自然语言交给 Google 自己解析并创建日程，例如「明天下午3点 和 张总 开会」。'
        + '解析由 Google 完成，适合简单表达；需要精确控制参与者、重复规则、提醒时请用 gcal_create_event。',
      parameters: {
        text: stringParam('自然语言描述，例如「周五下午2点 项目评审 会议室A」', true),
        calendarId: stringParam('目标日历 ID；不填用主日历'),
        sendUpdates: enumParam(SEND_UPDATES, '是否通知参与者：all / externalOnly / none'),
        timeZone: stringParam('时区；不填用插件配置的时区'),
      },
      async run(args) {
        guard.assertWrite(args, '快速创建日程');
        const zone = timeZoneOf(args);
        const calendarId = calendarIdOf(args);
        const created = await calendar.quickAdd(calendarId, requireString(args, 'text'), {
          sendUpdates: optionalString(args, 'sendUpdates') ?? 'none',
        });
        return {
          text: [
            '已按自然语言创建日程：',
            `标题：${created?.summary ?? '(无标题)'}`,
            `时间：${formatEventLine(created, { timeZone: zone })}`,
            `id：${created?.id}`,
          ].join('\n'),
          data: { ...created, _calendarId: calendarId },
        };
      },
    }),

    toolSpec({
      name: 'gcal_move_event',
      title: '移动日程到其它日历',
      kind: 'write',
      description: '把某个日程从一个日历移动到另一个日历（例如从个人日历挪到工作日历）。'
        + '常用于纠正建错日历的会议；日程 ID 保持不变。',
      parameters: {
        eventId: stringParam('要移动的事件 ID', true),
        destination: stringParam('目标日历 ID（必填）', true),
        calendarId: stringParam('事件当前所在日历 ID；不填用主日历'),
        sendUpdates: enumParam(SEND_UPDATES, '是否通知参与者：all / externalOnly / none（默认 none）'),
      },
      async run(args) {
        guard.assertWrite(args, '移动日程');
        const calendarId = calendarIdOf(args);
        const destination = requireString(args, 'destination');
        const eventId = requireString(args, 'eventId');
        const moved = await calendar.moveEvent(
          calendarId,
          eventId,
          destination,
          { sendUpdates: optionalString(args, 'sendUpdates') ?? 'none' },
        );
        const zone = timeZoneOf(args);
        // `events.move` 的响应可能带着源日历那份「已取消」墓碑的状态，
        // 直接展示会出现「已移动……（已取消）」这种自相矛盾的文案。
        // 因此从目标日历回读一次，用权威结果做确认。
        let confirmed = moved;
        try {
          confirmed = await calendar.getEvent(destination, eventId) ?? moved;
        } catch (error) {
          logger?.debug?.('[google] 移动后回读失败，退回使用 move 响应', { message: error?.message });
        }
        return {
          text: `已移动日程「${confirmed?.summary ?? '(无标题)'}」到日历 ${destination}\n`
            + `时间：${formatEventLine(confirmed, { timeZone: zone })}\n`
            + `状态：${confirmed?.status === 'cancelled' ? '⚠ 已取消' : '正常'}`,
          data: { ...confirmed, _calendarId: destination },
        };
      },
    }),

    toolSpec({
      name: 'gcal_find_free_slots',
      title: '查找共同空闲时间',
      kind: 'read',
      description: '在给定时间范围内查找空闲时段，可一次查询多个日历（例如同时看自己和同事的日历，找出都有空的时间）。'
        + '默认只看工作日 09:00–18:00，可用 includeWeekends 与 dayStart/dayEnd 调整。',
      parameters: {
        timeMin: stringParam('搜索范围起点，例如「明天」「+1d」', true),
        timeMax: stringParam('搜索范围终点，例如「+7d」「下周五」', true),
        calendars: stringListParam('要一起考虑的日历 ID 列表（默认 ["primary"]）'),
        durationMinutes: intParam('需要的时长（分钟），默认 60'),
        dayStart: stringParam('每天可用的开始时刻，例如 09:00（默认全天可用）'),
        dayEnd: stringParam('每天可用的结束时刻，例如 18:00（默认全天可用）'),
        includeWeekends: boolParam('是否包含周六周日（默认 false，仅工作日）'),
        maxSlots: intParam('最多返回多少个候选时段（默认 10）'),
        timeZone: stringParam('时区；不填用插件配置的时区'),
      },
      async run(args) {
        const zone = timeZoneOf(args);
        const current = clock();
        const rangeStart = parseBoundary(requireString(args, 'timeMin'), { timeZone: zone, now: current, edge: 'start' });
        const rangeEnd = parseBoundary(requireString(args, 'timeMax'), { timeZone: zone, now: current, edge: 'end' });
        if (rangeEnd <= rangeStart) throw new ToolInputError('timeMax 必须晚于 timeMin。');
        const duration = parseDurationMinutes(args?.durationMinutes) ?? 60;
        const includeWeekends = args?.includeWeekends === true;
        const maxSlots = clampLimit(args?.maxSlots, 10, 100);
        const dayStart = parseClock(optionalString(args, 'dayStart'), '00:00');
        const dayEnd = parseClock(optionalString(args, 'dayEnd'), '23:59');
        const asMinutes = (clock) => clock.hour * 60 + clock.minute;
        if (asMinutes(dayEnd) <= asMinutes(dayStart)) throw new ToolInputError('dayEnd 必须晚于 dayStart。');
        const calendars = normalizeStringList(args?.calendars).length > 0 ? normalizeStringList(args.calendars) : ['primary'];

        const busy = await fetchBusyIntervals(calendars, rangeStart, rangeEnd, zone);
        const merged = mergeIntervals(busy);

        const slots = [];
        const todayDate = toDateString(partsInZone(rangeStart, zone));
        for (let dayOffset = 0; dayOffset < 60 && slots.length < maxSlots; dayOffset += 1) {
          const date = addDays(todayDate, dayOffset);
          const dayParts = parseClockParts(date);
          const dayStartEpoch = Math.max(rangeStart, clockOnDate(date, dayStart, zone));
          const dayEndEpoch = Math.min(rangeEnd, clockOnDate(date, dayEnd, zone));
          if (dayEndEpoch <= dayStartEpoch) {
            if (clockOnDate(date, { hour: 0, minute: 0 }, zone) > rangeEnd) break;
            continue;
          }
          const weekday = new Date(Date.UTC(dayParts.year, dayParts.month - 1, dayParts.day)).getUTCDay();
          if (!includeWeekends && (weekday === 0 || weekday === 6)) continue;
          for (const gap of subtractIntervals(dayStartEpoch, dayEndEpoch, merged)) {
            // 在每段空闲里按「所需时长」切分出互不重叠的候选时段。
            const step = duration * 60000;
            for (let slotStart = gap.start; slotStart + step <= gap.end; slotStart += step) {
              slots.push({ start: slotStart, end: slotStart + step });
              if (slots.length >= maxSlots) break;
            }
            if (slots.length >= maxSlots) break;
          }
          if (slots.length >= maxSlots) break;
        }

        if (slots.length === 0) {
          return {
            text: `在 ${formatDateTimeLabel(rangeStart, zone)} 至 ${formatDateTimeLabel(rangeEnd, zone)} 之间`
              + `没有找到长度 ${duration} 分钟的共同空闲时间。可以放宽每天可用时段（dayStart/dayEnd）、`
              + '缩短时长，或扩大搜索范围。',
            data: { slots: [], durationMinutes: duration, calendars },
          };
        }
        const lines = slots.map((slot, index) => `${index + 1}. ${formatDateTimeLabel(slot.start, zone)} – ${formatDateTimeLabel(slot.end, zone).slice(-5)}`);
        return {
          text: [
            `在 ${formatDateTimeLabel(rangeStart, zone)} 至 ${formatDateTimeLabel(rangeEnd, zone)} 之间找到 ${slots.length} 个候选时段`
              + `（时长 ${duration} 分钟，日历：${calendars.join('、')}）：`,
            ...lines,
          ].join('\n'),
          data: { slots: slots.map((slot) => ({ start: toRfc3339(slot.start, zone), end: toRfc3339(slot.end, zone) })), durationMinutes: duration, calendars },
        };
      },
    }),

    toolSpec({
      name: 'gcal_respond_to_invite',
      title: '回复日程邀请',
      kind: 'write',
      description: '以当前账号身份接受、拒绝或暂定一个日程邀请（更新自己的参与状态）。'
        + '适用于收到邀请后直接在对话里处理，无需打开 Google 日历。',
      parameters: {
        eventId: stringParam('邀请对应的事件 ID', true),
        response: enumParam(['accepted', 'declined', 'tentative'], '回复：接受 / 拒绝 / 暂定', true),
        calendarId: stringParam('事件所在日历 ID；不填用主日历'),
        sendUpdates: enumParam(SEND_UPDATES, '是否通知组织者：all / externalOnly / none（默认 all）'),
        timeZone: stringParam('时区；不填用插件配置的时区'),
      },
      async run(args) {
        guard.assertWrite(args, '回复日程邀请');
        const zone = timeZoneOf(args);
        const calendarId = calendarIdOf(args);
        const eventId = requireString(args, 'eventId');
        const response = requireString(args, 'response');
        const original = await fetchEvent(calendarId, eventId);
        const attendees = Array.isArray(original.attendees) ? [...original.attendees] : [];
        const self = attendees.find((item) => item.self === true);
        if (!self) {
          throw new ToolInputError('该日程的参与者列表中没有当前账号，无法回复邀请。');
        }
        self.responseStatus = response;
        const updated = await calendar.patchEvent(
          calendarId,
          eventId,
          { attendees },
          { sendUpdates: optionalString(args, 'sendUpdates') ?? 'all' },
        );
        const label = { accepted: '已接受', declined: '已拒绝', tentative: '已暂定' }[response] ?? response;
        return {
          text: `${label}日程「${updated?.summary ?? original.summary ?? '(无标题)'}」\n时间：${formatEventLine(updated ?? original, { timeZone: zone })}`,
          data: { ...(updated ?? original), _calendarId: calendarId },
        };
      },
    }),
  ];

  /** 解析 `HH:MM` 形式的时刻。 */
  function parseClock(text, fallback) {
    const source = text ?? fallback;
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(source).trim());
    if (!match) throw new ToolInputError(`时间格式应为 HH:MM，收到「${source}」。`);
    return { hour: Number(match[1]), minute: Number(match[2]) };
  }

  /** 解析 `YYYY-MM-DD`。 */
  function parseClockParts(date) {
    const [year, month, day] = String(date).split('-').map(Number);
    return { year, month, day };
  }

  /** 某天某个时刻的毫秒时间戳。 */
  function clockOnDate(date, clockParts, zone) {
    return deps.epochFromParts({ ...parseClockParts(date), hour: clockParts.hour, minute: clockParts.minute, second: 0 }, zone);
  }

  /** 查询多个日历的忙碌区间。 */
  async function fetchBusyIntervals(calendars, timeMin, timeMax, zone) {
    const response = await calendar.freeBusy({
      timeMin: toRfc3339(timeMin, zone),
      timeMax: toRfc3339(timeMax, zone),
      timeZone: zone,
      items: calendars.map((id) => ({ id })),
    });
    const out = [];
    for (const [id, entry] of Object.entries(response?.calendars ?? {})) {
      for (const interval of entry?.busy ?? []) {
        const start = Date.parse(interval.start);
        const end = Date.parse(interval.end);
        if (Number.isFinite(start) && Number.isFinite(end)) out.push({ start, end, calendarId: id });
      }
    }
    return out;
  }

  /** 合并重叠区间。 */
  function mergeIntervals(intervals) {
    const sorted = [...intervals].sort((a, b) => a.start - b.start);
    const merged = [];
    for (const interval of sorted) {
      const last = merged[merged.length - 1];
      if (last && interval.start <= last.end) {
        last.end = Math.max(last.end, interval.end);
      } else {
        merged.push({ ...interval });
      }
    }
    return merged;
  }

  /** 从 [start, end) 中挖掉忙碌区间。 */
  function subtractIntervals(start, end, busy) {
    const gaps = [];
    let cursor = start;
    for (const interval of busy) {
      if (interval.end <= cursor) continue;
      if (interval.start >= end) break;
      if (interval.start > cursor) gaps.push({ start: cursor, end: Math.min(interval.start, end) });
      cursor = Math.max(cursor, interval.end);
      if (cursor >= end) break;
    }
    if (cursor < end) gaps.push({ start: cursor, end });
    return gaps;
  }
}

/** 事件排序用的起始时刻。 */
function eventStartEpoch(event) {
  const value = event?.start?.dateTime ?? event?.start?.date;
  const epoch = Date.parse(value ?? '');
  return Number.isFinite(epoch) ? epoch : Number.MAX_SAFE_INTEGER;
}
