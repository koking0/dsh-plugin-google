/**
 * Google Tasks API v1 客户端。
 *
 * 注意 Google Tasks 的两组路径并不对称（以官方 Discovery 文档为准）：
 * - 任务列表：`/users/@me/lists[/{tasklist}]`
 * - 任务：    `/lists/{tasklist}/tasks[/{task}]`、`/lists/{tasklist}/clear`
 *
 * 层级模型为 任务列表 → 任务 → 子任务（`parent`）。移动通过 `tasks.move` 完成，
 * 支持改父任务、重排与跨列表移动（`destinationTasklist`）。
 *
 * @module dsh-plugin-google/lib/tasks-api
 */

import { createCaller, encodePathSegment } from './api-core.js';

/**
 * 创建 Tasks API 客户端。
 *
 * @param {object} options - 依赖。
 * @param {object} options.http - HTTP 客户端。
 * @param {object} options.auth - 授权模块。
 * @param {string} options.baseUrl - API 基础地址。
 * @param {object} [options.logger] - 可选日志器。
 * @returns {object} Tasks API 方法集合。
 */
export function createTasksApi({ http, auth, baseUrl, logger }) {
  const call = createCaller({ http, auth, baseUrl, logger });
  /** 任务列表资源路径。 */
  const listPath = (taskListId) => `/users/@me/lists/${encodePathSegment(taskListId)}`;
  /** 任务资源路径（不含 `tasks` 段）。 */
  const tasksPath = (taskListId) => `/lists/${encodePathSegment(taskListId)}`;
  const taskPath = (taskListId, taskId) => `${tasksPath(taskListId)}/tasks/${encodePathSegment(taskId)}`;

  return {
    baseUrl,

    /** 列出所有任务列表。 */
    listTaskLists: (query, options) => call('GET', '/users/@me/lists', { query, ...options }),

    /** 读取单个任务列表。 */
    getTaskList: (taskListId, options) => call('GET', listPath(taskListId), options),

    /** 新建任务列表。 */
    createTaskList: (body, options) => call('POST', '/users/@me/lists', { body, ...options }),

    /** 修改任务列表标题。 */
    patchTaskList: (taskListId, body, options) => call('PATCH', listPath(taskListId), { body, ...options }),

    /** 删除任务列表（其中的任务一并删除）。 */
    deleteTaskList: (taskListId, options) => call('DELETE', listPath(taskListId), options),

    /** 查询任务。 */
    listTasks: (taskListId, query, options) => call('GET', `${tasksPath(taskListId)}/tasks`, { query, ...options }),

    /** 读取单个任务。 */
    getTask: (taskListId, taskId, options) => call('GET', taskPath(taskListId, taskId), options),

    /**
     * 新建任务。
     *
     * `parent` / `previous` 作为查询参数传给 Google，用于指定父任务与排序位置。
     */
    createTask: (taskListId, body, query, options) => call('POST', `${tasksPath(taskListId)}/tasks`, { body, query, ...options }),

    /** 修改任务（部分更新）。 */
    patchTask: (taskListId, taskId, body, options) => call('PATCH', taskPath(taskListId, taskId), { body, ...options }),

    /** 删除任务。 */
    deleteTask: (taskListId, taskId, options) => call('DELETE', taskPath(taskListId, taskId), options),

    /** 移动任务（可改父任务、排序或跨列表）。 */
    moveTask: (taskListId, taskId, query, options) => call('POST', `${taskPath(taskListId, taskId)}/move`, { query, ...options }),

    /** 清空列表中所有已完成任务。 */
    clearCompleted: (taskListId, options) => call('POST', `${tasksPath(taskListId)}/clear`, options),
  };
}
