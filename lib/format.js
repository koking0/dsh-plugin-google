/**
 * 面向模型与用户的中文渲染工具。
 *
 * 所有工具返回 `{ text, data }`：`text` 是给人/模型看的摘要，`data` 是结构化数据。
 * 这里集中处理事件、任务、日历的展示格式，避免每个工具各写一套。
 *
 * @module dsh-plugin-google/lib/format
 */

import { formatDateLabel, formatDateTimeLabel, partsInZone, toDateString } from './time.js';

/** 工具输出的内容块。 */
export function textBlock(text) {
  return [{ type: 'text', text: String(text ?? '') }];
}

/** 截断过长文本。 */
export function truncate(text, limit = 120) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/** 把毫秒时长渲染为 `1小时30分钟`。 */
export function formatDuration(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return '';
  const hours = Math.floor(value / 60);
  const mins = Math.round(value % 60);
  if (hours && mins) return `${hours}小时${mins}分钟`;
  if (hours) return `${hours}小时`;
  return `${mins}分钟`;
}

/** 事件时间点渲染：支持全天（`date`）与定时（`dateTime`）。 */
function eventTimePoint(point, timeZone) {
  if (!point) return undefined;
  if (point.date) return { kind: 'date', date: point.date, label: formatDateLabel(point.date) };
  if (point.dateTime) {
    const epoch = Date.parse(point.dateTime);
    if (Number.isFinite(epoch)) {
      return { kind: 'dateTime', epoch, label: formatDateTimeLabel(epoch, timeZone), raw: point.dateTime, timeZone: point.timeZone };
    }
  }
  return undefined;
}

/** 事件时间区间渲染：`15:00–16:00` 或 `2026-10-06 全天`。 */
export function formatEventWhen(event, timeZone) {
  const start = eventTimePoint(event?.start, timeZone);
  const end = eventTimePoint(event?.end, timeZone);
  if (!start) return '时间未知';
  if (start.kind === 'date') {
    if (!end) return `${start.label}（全天）`;
    // Google 的全天事件 end.date 是不含的次日。
    const endLabel = end.date ? formatDateLabel(end.date) : end.label;
    return start.date === end.date ? `${start.label}（全天）` : `${start.label} 至 ${endLabel}（全天）`;
  }
  if (!end) return start.label;
  if (end.kind === 'dateTime' && Number.isFinite(end.epoch)) {
    const startParts = partsInZone(start.epoch, timeZone);
    const endParts = partsInZone(end.epoch, timeZone);
    const endTime = `${String(endParts.hour).padStart(2, '0')}:${String(endParts.minute).padStart(2, '0')}`;
    const sameDay = toDateString(startParts) === toDateString(endParts);
    if (sameDay) return `${start.label}–${endTime}`;
    return `${start.label} → ${end.label}`;
  }
  return start.label;
}

/** 事件的参与者摘要。 */
function attendeesSummary(event) {
  const attendees = Array.isArray(event?.attendees) ? event.attendees : [];
  if (attendees.length === 0) return '';
  const self = attendees.find((item) => item.self);
  const selfStatus = self?.responseStatus;
  const statusText = { accepted: '已接受', declined: '已拒绝', tentative: '暂定', needsAction: '待回复' }[selfStatus];
  return `${attendees.length} 人参与${statusText ? `（我：${statusText}）` : ''}`;
}

/** 会议链接（Google Meet 等）。 */
function conferenceSummary(event) {
  const entryPoints = event?.conferenceData?.entryPoints;
  if (!Array.isArray(entryPoints)) return '';
  const video = entryPoints.find((item) => item.entryPointType === 'video');
  return video?.uri ? `视频会议：${video.uri}` : '';
}

/**
 * 单行事件摘要，便于列表展示。
 *
 * @param {object} event - Calendar 事件资源。
 * @param {object} [options] - `{ timeZone, calendarName }`。
 * @returns {string} 单行文本。
 */
export function formatEventLine(event, { timeZone, calendarName } = {}) {
  const parts = [];
  parts.push(`• ${formatEventWhen(event, timeZone)}`);
  parts.push(event?.summary || '(无标题)');
  if (event?.location) parts.push(`@ ${truncate(event.location, 40)}`);
  const attendees = attendeesSummary(event);
  if (attendees) parts.push(attendees);
  if (calendarName) parts.push(`[${calendarName}]`);
  if (event?.status === 'cancelled') parts.push('（已取消）');
  if (event?.recurringEventId) parts.push('（周期性实例）');
  if (event?.id) parts.push(`id=${event.id}`);
  return parts.join(' · ');
}

/**
 * 事件详情（多行）。
 *
 * @param {object} event - Calendar 事件资源。
 * @param {object} [options] - `{ timeZone, calendarName }`。
 * @returns {string} 多行文本。
 */
export function formatEventDetail(event, { timeZone, calendarName } = {}) {
  const lines = [`标题：${event?.summary || '(无标题)'}`];
  lines.push(`时间：${formatEventWhen(event, timeZone)}`);
  if (calendarName) lines.push(`日历：${calendarName}`);
  if (event?.location) lines.push(`地点：${event.location}`);
  if (Array.isArray(event?.attendees) && event.attendees.length > 0) {
    const list = event.attendees.map((item) => {
      const status = { accepted: '已接受', declined: '已拒绝', tentative: '暂定', needsAction: '待回复' }[item.responseStatus] ?? '';
      const name = item.displayName ? `${item.displayName} <${item.email}>` : item.email;
      return `${name}${status ? `(${status})` : ''}`;
    });
    lines.push(`参与者：${list.join('、')}`);
  }
  if (event?.description) lines.push(`描述：${truncate(event.description, 500)}`);
  if (Array.isArray(event?.recurrence) && event.recurrence.length > 0) lines.push(`重复规则：${event.recurrence.join(' ; ')}`);
  if (event?.hangoutLink) lines.push(`Google Meet：${event.hangoutLink}`);
  const conference = conferenceSummary(event);
  if (conference) lines.push(conference);
  if (event?.status) lines.push(`状态：${event.status}`);
  if (event?.htmlLink) lines.push(`链接：${event.htmlLink}`);
  if (event?.iCalUID) lines.push(`iCalUID：${event.iCalUID}`);
  return lines.join('\n');
}

/**
 * 日历元信息摘要。
 * @param {object} calendar - calendarList 条目。
 * @returns {string} 单行文本。
 */
export function formatCalendarLine(calendar) {
  const parts = [];
  parts.push(calendar?.primary ? '★' : '·');
  parts.push(calendar?.summaryOverride || calendar?.summary || '(未命名日历)');
  parts.push(calendar?.id === calendar?.summary ? '' : `<${calendar?.id}>`);
  if (calendar?.accessRole) parts.push(`权限:${calendar.accessRole}`);
  if (calendar?.timeZone) parts.push(`时区:${calendar.timeZone}`);
  if (calendar?.primary) parts.push('主日历');
  return parts.filter(Boolean).join(' ');
}

/**
 * 渲染 Google Tasks 的 `due`。
 *
 * Tasks API 会丢弃 `due` 中的时刻，只保留日期语义，因此这里一律按日期部分渲染，
 * 避免用本地时区换算导致「差一天」。
 *
 * @param {string} due - RFC 3339 字符串。
 * @returns {string} 形如 `2026-10-06 周二`。
 */
export function formatTaskDue(due) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(due ?? ''));
  if (!match) return String(due ?? '');
  return formatDateLabel(match[1]);
}

/**
 * 单行任务摘要。
 *
 * @param {object} task - Tasks 任务资源。
 * @param {object} [options] - `{ timeZone, listName }`。
 * @returns {string} 单行文本。
 */
export function formatTaskLine(task, { timeZone, listName } = {}) {
  const done = String(task?.status ?? '').toLowerCase() === 'completed';
  const parts = [done ? '☑' : '☐', task?.title || '(无标题)'];
  if (task?.due) parts.push(`截止 ${formatTaskDue(task.due)}`);
  if (done && task?.completed) {
    const epoch = Date.parse(task.completed);
    if (Number.isFinite(epoch)) parts.push(`完成于 ${formatDateTimeLabel(epoch, timeZone)}`);
  }
  if (task?.notes) parts.push(`备注：${truncate(task.notes, 60)}`);
  if (listName) parts.push(`[${listName}]`);
  if (task?.id) parts.push(`id=${task.id}`);
  return parts.join(' · ');
}

/**
 * 任务详情（多行）。
 *
 * @param {object} task - Tasks 任务资源。
 * @param {object} [options] - `{ timeZone, listName, subtasks }`。
 * @returns {string} 多行文本。
 */
export function formatTaskDetail(task, { timeZone, listName, subtasks = [] } = {}) {
  const lines = [`标题：${task?.title || '(无标题)'}`];
  lines.push(`状态：${task?.status === 'completed' ? '已完成' : '未完成'}`);
  if (task?.due) lines.push(`截止：${formatTaskDue(task.due)}`);
  if (listName) lines.push(`列表：${listName}`);
  if (task?.notes) lines.push(`备注：${task.notes}`);
  if (task?.parent) lines.push(`父任务 ID：${task.parent}`);
  if (task?.completed) lines.push(`完成时间：${task.completed}`);
  if (task?.webViewLink) lines.push(`链接：${task.webViewLink}`);
  if (subtasks.length > 0) {
    lines.push(`子任务（${subtasks.length}）：`);
    for (const sub of subtasks) lines.push(`  ${formatTaskLine(sub, { timeZone })}`);
  }
  return lines.join('\n');
}

/**
 * 列表表头。
 * @param {string} label - 资源名称。
 * @param {number} total - 总数。
 * @param {number} shown - 展示数。
 * @param {boolean} truncated - 是否被截断。
 * @param {string} [nextPageToken] - 下一页令牌。
 * @returns {string} 表头文本。
 */
export function listHeader(label, total, shown, truncated, nextPageToken) {
  if (total === 0) return `未找到符合条件的${label}。`;
  const base = truncated
    ? `共 ${total} 个${label}，已显示前 ${shown} 个（可用过滤条件缩小范围）：`
    : `共 ${total} 个${label}：`;
  return nextPageToken ? `${base}\n（还有更多结果，可传 pageToken="${nextPageToken}" 继续读取）` : base;
}
