/**
 * 「今日/本周视图」：把 Google 日历与 Google Tasks 合并成一份可读的日程摘要。
 *
 * 这是最贴近日常使用的入口：用户问「我今天有什么安排」「这周怎么样」时，
 * 一次调用即可拿到按天排列的日程、待办、逾期任务与时间冲突提醒。
 *
 * @module dsh-plugin-google/lib/tools/agenda
 */

import { formatEventLine, formatTaskLine } from '../format.js';
import {
  addDays,
  formatDateLabel,
  formatDateTimeLabel,
  parseBoundary,
  partsInZone,
  toDateString,
} from '../time.js';
import {
  boolParam,
  intParam,
  normalizeStringList,
  optionalString,
  stringListParam,
  stringParam,
  toolSpec,
} from './common.js';

/**
 * 创建日程摘要工具。
 *
 * @param {object} deps - 插件依赖。
 * @returns {object[]} 工具规格数组。
 */
export function createAgendaTools(deps) {
  const { calendar, tasks, config, logger, now } = deps;
  const tz = deps.timeZone;
  const clock = () => (typeof now === 'function' ? now() : Date.now());

  return [
    toolSpec({
      name: 'google_agenda',
      title: '查看日程与待办汇总',
      kind: 'read',
      description: '把 Google 日历和 Google Tasks 合并成一份按天排列的摘要：每天有哪些日程、当天到期的待办、'
        + '以及已逾期但未完成的任务，并提示时间冲突。回答「今天/明天/这周有什么安排」这类问题时优先用它。'
        + '默认查询所有日历与所有任务列表。',
      parameters: {
        date: stringParam('起始日期，支持自然语言（「今天」「明天」「下周一」），默认今天'),
        days: intParam('连续查看多少天，默认 1（今天）；查本周可传 7'),
        calendars: stringListParam('要包含的日历 ID 列表；不填表示所有可见日历'),
        includeTasks: boolParam('是否包含 Google Tasks 待办（默认 true；显式指定 calendars 时默认 false）'),
        taskListId: stringParam('只查看某个任务列表；不填表示所有列表'),
        includeOverdue: boolParam('是否单独列出已逾期未完成的任务（默认 true）'),
        includeUndated: boolParam('是否列出没有截止日期的未完成任务（默认 false）'),
        timeZone: stringParam('时区；不填用插件配置的时区'),
      },
      async run(args) {
        const zone = optionalString(args, 'timeZone') ?? tz;
        const current = clock();
        const days = Math.min(Math.max(Math.floor(Number(args?.days) || 1), 1), 31);
        const startRaw = optionalString(args, 'date') ?? 'today';
        const rangeStart = parseBoundary(startRaw, { timeZone: zone, now: current, edge: 'start' });
        const startDate = toDateString(partsInZone(rangeStart, zone));
        const lastDate = addDays(startDate, days - 1);
        const rangeEnd = parseBoundary(lastDate, { timeZone: zone, now: current, edge: 'end' });

        // 1) 日程：默认覆盖所有可见日历。
        const requestedCalendars = normalizeStringList(args?.calendars);
        let calendarTargets = [];
        if (requestedCalendars.length > 0) {
          calendarTargets = requestedCalendars.map((id) => ({ id, summary: id }));
        } else {
          const list = await calendar.listCalendars({ maxResults: 250 });
          calendarTargets = (list?.items ?? [])
            .filter((item) => item.deleted !== true && item.hidden !== true)
            .map((item) => ({
              id: item.id,
              summary: item.summaryOverride ?? item.summary,
              accessRole: item.accessRole,
            }));
        }
        const events = [];
        for (const target of calendarTargets) {
          try {
            const response = await calendar.listEvents(target.id, {
              timeMin: new Date(rangeStart).toISOString(),
              timeMax: new Date(rangeEnd).toISOString(),
              singleEvents: true,
              orderBy: 'startTime',
              maxResults: 250,
            });
            for (const event of response?.items ?? []) {
              if (event.status === 'cancelled') continue;
              events.push({ event, calendarId: target.id, calendarName: target.summary });
            }
          } catch (error) {
            logger?.debug?.('[google] 汇总视图跳过一个日历', { calendarId: target.id, message: error?.message });
          }
        }
        events.sort((a, b) => eventStart(a.event) - eventStart(b.event));

        // 2) 待办：按截止日期归类。
        //
        // 显式指定了 calendars 时默认**不**带待办：这种调用通常是「只看某几个人/某几个日历」，
        // 再附上全局待办（尤其几十条逾期）只会淹没真正要看的日程。
        let taskEntries = [];
        let overdue = [];
        let undated = [];
        const includeTasks = args?.includeTasks ?? (requestedCalendars.length === 0);
        if (includeTasks) {
          const listId = optionalString(args, 'taskListId');
          let lists = [];
          if (listId) {
            lists = [{ id: listId, title: listId }];
          } else {
            try {
              const response = await tasks.listTaskLists({ maxResults: 100 });
              lists = (response?.items ?? []).map((item) => ({ id: item.id, title: item.title }));
            } catch (error) {
              logger?.debug?.('[google] 汇总视图读取任务列表失败', { message: error?.message });
            }
          }
          for (const list of lists) {
            try {
              const response = await tasks.listTasks(list.id, { maxResults: 100, showCompleted: true });
              for (const task of response?.items ?? []) {
                const entry = { task, listId: list.id, listTitle: list.title };
                if (task.status === 'completed') {
                  // 已完成任务只在范围内展示，避免噪音。
                  if (task.due && task.due.slice(0, 10) >= startDate && task.due.slice(0, 10) <= lastDate) taskEntries.push(entry);
                  continue;
                }
                if (!task.due) {
                  if (args?.includeUndated === true) undated.push(entry);
                  continue;
                }
                const dueDate = task.due.slice(0, 10);
                if (dueDate < startDate) {
                  if (args?.includeOverdue !== false) overdue.push(entry);
                } else if (dueDate <= lastDate) {
                  taskEntries.push(entry);
                }
              }
            } catch (error) {
              logger?.debug?.('[google] 汇总视图跳过一个任务列表', { listId: list.id, message: error?.message });
            }
          }
        }

        // 3) 按天组装。
        const buckets = [];
        for (let index = 0; index < days; index += 1) {
          const date = addDays(startDate, index);
          buckets.push({
            date,
            label: formatDateLabel(date),
            events: events.filter((entry) => eventDate(entry.event, zone) === date),
            tasks: taskEntries.filter((entry) => entry.task.due?.slice(0, 10) === date),
          });
        }

        // 4) 冲突检测：只在你**自己的**日历之间判定。
        //
        // 必须跨日历（课表常在一个日历、生活安排在不同日历，只看同一日历会漏掉真正的双重预约），
        // 但必须排除两类噪音源：
        //   1. 只读订阅日历（accessRole=reader，例如节假日日历）；
        //   2. `config.otherCalendarIds` 里登记为「他人日程」的日历
        //      —— 例如研究生的课表，你和他们时间重叠是正常的，不是冲突。
        const otherCalendarIds = new Set(
          Array.isArray(config.otherCalendarIds) ? config.otherCalendarIds : [],
        );
        const eligibleCalendars = new Set(
          calendarTargets
            .filter((target) => ['owner', 'writer', undefined].includes(target.accessRole))
            .filter((target) => !otherCalendarIds.has(target.id))
            .map((target) => target.id),
        );
        const calendarNames = new Map(calendarTargets.map((target) => [target.id, target.summary]));
        const conflicts = findConflicts(
          events.filter((entry) => eligibleCalendars.has(entry.calendarId)),
        );

        const lines = [];
        const totalEvents = buckets.reduce((sum, bucket) => sum + bucket.events.length, 0);
        const totalTasks = buckets.reduce((sum, bucket) => sum + bucket.tasks.length, 0);
        const rangeLabel = days === 1
          ? formatDateLabel(startDate)
          : `${formatDateLabel(startDate)} 至 ${formatDateLabel(lastDate)}`;
        lines.push(`${rangeLabel}：${totalEvents} 条日程、${totalTasks} 条待办`);
        for (const bucket of buckets) {
          if (days > 1) lines.push('');
          if (days > 1) lines.push(`── ${bucket.label} ──`);
          if (bucket.events.length === 0 && bucket.tasks.length === 0) {
            lines.push('（无安排）');
            continue;
          }
          if (bucket.events.length > 0) {
            lines.push('日程：');
            for (const entry of bucket.events) {
              lines.push(`  ${formatEventLine(entry.event, { timeZone: zone, calendarName: days > 1 ? entry.calendarName : undefined })}`);
            }
          }
          if (bucket.tasks.length > 0) {
            lines.push('待办：');
            for (const entry of bucket.tasks) {
              lines.push(`  ${formatTaskLine(entry.task, { timeZone: zone, listName: entry.listTitle })}`);
            }
          }
        }
        // 逾期任务可能很多（几十条），只预览前若干条，避免把当天日程淹没；
        // 完整列表仍可从 data.overdue 取，或用 gtasks_list_tasks 查询。
        const OVERDUE_PREVIEW = 15;
        if (overdue.length > 0) {
          lines.push('');
          lines.push(`⚠ 已逾期未完成（${overdue.length}）：`);
          for (const entry of overdue.slice(0, OVERDUE_PREVIEW)) {
            lines.push(`  ${formatTaskLine(entry.task, { timeZone: zone, listName: entry.listTitle })}`);
          }
          if (overdue.length > OVERDUE_PREVIEW) {
            lines.push(`  …另有 ${overdue.length - OVERDUE_PREVIEW} 条逾期任务未列出（完整列表见 data.overdue，或用 gtasks_list_tasks taskListId=all 查询）`);
          }
        }
        if (undated.length > 0) {
          lines.push('');
          lines.push(`无截止日期的未完成任务（${undated.length}）：`);
          for (const entry of undated.slice(0, 20)) lines.push(`  ${formatTaskLine(entry.task, { timeZone: zone, listName: entry.listTitle })}`);
        }
        if (conflicts.length > 0) {
          lines.push('');
          lines.push(`⚠ 时间冲突（${conflicts.length} 组）：`);
          for (const pair of conflicts) {
            const label = (item) => (calendarNames.get(item.calendarId) && calendarNames.get(item.calendarId) !== item.calendarId
              ? `${formatDateTimeLabel(item.start, zone)} 的「${item.summary}」（${calendarNames.get(item.calendarId)}）`
              : `${formatDateTimeLabel(item.start, zone)} 的「${item.summary}」`);
            lines.push(`  ${label(pair.a)} 与 ${label(pair.b)} 重叠`);
          }
        }

        return {
          text: lines.join('\n'),
          data: {
            range: { start: startDate, end: lastDate, days },
            timeZone: zone,
            calendars: calendarTargets,
            days: buckets.map((bucket) => ({
              date: bucket.date,
              events: bucket.events.map((entry) => ({ ...entry.event, _calendarId: entry.calendarId })),
              tasks: bucket.tasks.map((entry) => ({ ...entry.task, _taskListId: entry.listId })),
            })),
            overdue: overdue.map((entry) => ({ ...entry.task, _taskListId: entry.listId })),
            undated: undated.map((entry) => ({ ...entry.task, _taskListId: entry.listId })),
            conflicts: conflicts.map((pair) => ({
              start: pair.a.start,
              summaryA: pair.a.summary,
              calendarIdA: pair.a.calendarId,
              summaryB: pair.b.summary,
              calendarIdB: pair.b.calendarId,
              overlapping: pair.b.start < pair.a.end,
            })),
          },
        };
      },
    }),
  ];
}

/** 事件排序用的起始时刻。 */
function eventStart(event) {
  const epoch = Date.parse(event?.start?.dateTime ?? event?.start?.date ?? '');
  return Number.isFinite(epoch) ? epoch : Number.MAX_SAFE_INTEGER;
}

/** 事件落在配置时区的哪一天。 */
function eventDate(event, zone) {
  if (event?.start?.date) return event.start.date;
  const epoch = Date.parse(event?.start?.dateTime ?? '');
  if (!Number.isFinite(epoch)) return undefined;
  return toDateString(partsInZone(epoch, zone));
}

/**
 * 检测互相重叠的定时日程（**跨日历**）。
 *
 * 只比较带具体时刻的事件：全天事件（`start.date`）不参与，否则节假日、
 * 出差这类整天标记会把所有日程都判成冲突。
 *
 * @param {object[]} entries - `{ event, calendarId }` 列表，调用方已过滤掉只读日历。
 * @returns {object[]} 冲突对。
 */
function findConflicts(entries) {
  const conflicts = [];
  const timed = entries
    .filter((entry) => entry.event?.start?.dateTime && entry.event?.end?.dateTime)
    .map((entry) => ({
      calendarId: entry.calendarId,
      summary: entry.event.summary ?? '(无标题)',
      start: Date.parse(entry.event.start.dateTime),
      end: Date.parse(entry.event.end.dateTime),
    }))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end))
    // 完全相同的重复实例（同一事件被多个日历共享）只留一份。
    .filter((item, index, all) => all.findIndex((other) => other.start === item.start
      && other.end === item.end && other.summary === item.summary) === index)
    .sort((a, b) => a.start - b.start);

  const seen = new Set();
  for (let index = 0; index < timed.length; index += 1) {
    for (let other = index + 1; other < timed.length; other += 1) {
      const a = timed[index];
      const b = timed[other];
      if (b.start >= a.end) break;
      const key = `${a.start}:${a.summary}:${b.start}:${b.summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({ a, b });
      if (conflicts.length >= 20) return conflicts;
    }
  }
  return conflicts;
}
