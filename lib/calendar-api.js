/**
 * Google Calendar API v3 客户端。
 *
 * 只封装插件真正用到的端点，保持薄封装：请求与错误处理交给 api-core。
 *
 * @module dsh-plugin-google/lib/calendar-api
 */

import { createCaller, encodePathSegment } from './api-core.js';

/**
 * 创建 Calendar API 客户端。
 *
 * @param {object} options - 依赖。
 * @param {object} options.http - HTTP 客户端。
 * @param {object} options.auth - 授权模块。
 * @param {string} options.baseUrl - API 基础地址。
 * @param {object} [options.logger] - 可选日志器。
 * @returns {object} Calendar API 方法集合。
 */
export function createCalendarApi({ http, auth, baseUrl, logger }) {
  const call = createCaller({ http, auth, baseUrl, logger });
  const calendarPath = (calendarId) => `/calendars/${encodePathSegment(calendarId)}`;

  return {
    baseUrl,

    /** 列出当前账号可见的日历（对应 Google Calendar 左侧列表）。 */
    listCalendars: (query, options) => call('GET', '/users/me/calendarList', { query, ...options }),

    /** 读取单个日历的元信息。`primary` 表示主日历。 */
    getCalendar: (calendarId, options) => call('GET', calendarPath(calendarId), options),

    /** 新建次级日历。 */
    createCalendar: (body, options) => call('POST', '/calendars', { body, ...options }),

    /** 修改日历元信息；`patch` 为 true 时只提交给定字段。 */
    updateCalendar: (calendarId, body, { patch = false, ...options } = {}) => call(patch ? 'PATCH' : 'PUT', calendarPath(calendarId), { body, ...options }),

    /** 删除次级日历（主日历不可删除）。 */
    deleteCalendar: (calendarId, options) => call('DELETE', calendarPath(calendarId), options),

    /** 查询事件列表。 */
    listEvents: (calendarId, query, options) => call('GET', `${calendarPath(calendarId)}/events`, { query, ...options }),

    /** 读取单个事件。 */
    getEvent: (calendarId, eventId, options) => call('GET', `${calendarPath(calendarId)}/events/${encodePathSegment(eventId)}`, options),

    /** 创建事件。 */
    createEvent: (calendarId, body, query, options) => call('POST', `${calendarPath(calendarId)}/events`, { body, query, ...options }),

    /** 修改事件（部分更新）。 */
    patchEvent: (calendarId, eventId, body, query, options) => call('PATCH', `${calendarPath(calendarId)}/events/${encodePathSegment(eventId)}`, { body, query, ...options }),

    /** 全量替换事件。 */
    replaceEvent: (calendarId, eventId, body, query, options) => call('PUT', `${calendarPath(calendarId)}/events/${encodePathSegment(eventId)}`, { body, query, ...options }),

    /** 删除事件。 */
    deleteEvent: (calendarId, eventId, query, options) => call('DELETE', `${calendarPath(calendarId)}/events/${encodePathSegment(eventId)}`, { query, ...options }),

    /** 自然语言快速创建（Google 端解析）。 */
    quickAdd: (calendarId, text, query, options) => call('POST', `${calendarPath(calendarId)}/events/quickAdd`, { query: { text, ...query }, ...options }),

    /** 把事件移动到另一个日历。 */
    moveEvent: (calendarId, eventId, destination, query, options) => call(
      'POST',
      `${calendarPath(calendarId)}/events/${encodePathSegment(eventId)}/move`,
      { query: { destination, ...query }, ...options },
    ),

    /** 查询多个日历的忙闲情况。 */
    freeBusy: (body, options) => call('POST', '/freeBusy', { body, ...options }),
  };
}
