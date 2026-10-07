/**
 * Google Tasks 工具集：任务列表与任务的增删改查、完成/取消完成、移动、清理已完成。
 *
 * Google Tasks 的两个重要约束在这里被显式处理：
 * 1. `due` 只保留日期语义（时刻被服务端丢弃）。本插件统一按「本地日历日期 + T00:00:00.000Z」
 *    写入，并按日期部分展示，避免跨时区出现「差一天」；
 * 2. 任务层级为 列表 → 任务 → 子任务，移动通过 `tasks.move` 完成，支持跨列表移动。
 *
 * @module dsh-plugin-google/lib/tools/tasks
 */

import { ToolInputError } from '../errors.js';
import {
  formatTaskDetail,
  formatTaskLine,
  listHeader,
} from '../format.js';
import { formatDateTimeLabel, parseBoundary, partsInZone, toDateString, toRfc3339 } from '../time.js';
import {
  boolParam,
  clampLimit,
  CONFIRM_PARAM,
  enumParam,
  intParam,
  optionalString,
  requireString,
  stringParam,
  toolSpec,
} from './common.js';

/**
 * 把「自然语言或 ISO 日期」转换为 Google Tasks 接受的 `due` 值。
 *
 * @param {string} value - 时间表达。
 * @param {string} timeZone - 解释自然语言所用时区。
 * @param {number} now - 当前时刻。
 * @returns {{due:string, date:string}} due 值与对应日期。
 */
export function dueValue(value, timeZone, now) {
  const parsed = parseBoundary(value, { timeZone, now, edge: 'start' });
  const date = toDateString(partsInZone(parsed, timeZone));
  // 服务端只看日期部分；固定用 UTC 零点表达该日期，避免时区把日期推前/推后一天。
  return { due: `${date}T00:00:00.000Z`, date };
}

/**
 * 创建 Tasks 工具。
 *
 * @param {object} deps - 插件依赖。
 * @returns {object[]} 工具规格数组。
 */
export function createTasksTools(deps) {
  const { tasks, config, guard, logger, now } = deps;
  const tz = deps.timeZone;

  const clock = () => (typeof now === 'function' ? now() : Date.now());
  const timeZoneOf = (args) => optionalString(args, 'timeZone') ?? tz;
  const taskListIdOf = (args) => optionalString(args, 'taskListId') ?? config.defaultTaskList ?? '@default';

  /** 读取任务列表名称映射，用于展示。 */
  async function listNameMap() {
    try {
      const response = await tasks.listTaskLists({ maxResults: 100 });
      const map = new Map();
      for (const item of response?.items ?? []) map.set(item.id, item.title);
      return map;
    } catch (error) {
      logger?.debug?.('[google] 读取任务列表失败', { message: error?.message });
      return new Map();
    }
  }

  /** 按标题/备注做本地过滤（Tasks API 没有全文搜索参数）。 */
  function filterByQuery(entries, query) {
    if (!query) return entries;
    const needle = query.toLowerCase();
    return entries.filter((entry) => `${entry.task?.title ?? ''} ${entry.task?.notes ?? ''}`.toLowerCase().includes(needle));
  }

  /** 读取任务及其直接子任务。 */
  async function fetchTaskWithChildren(taskListId, taskId) {
    let task;
    try {
      task = await tasks.getTask(taskListId, taskId);
    } catch (error) {
      if (error?.status === 404) {
        throw new ToolInputError(
          `未找到任务 ${taskId}（列表 ${taskListId}）。请用 gtasks_list_tasks 确认任务 ID 是否仍然存在。`,
          { status: 404 },
        );
      }
      throw error;
    }
    if (!task) throw new ToolInputError(`未找到任务 ${taskId}（列表 ${taskListId}）。`);
    let subtasks = [];
    try {
      const response = await tasks.listTasks(taskListId, { maxResults: 100, showCompleted: true, showHidden: true });
      subtasks = (response?.items ?? []).filter((item) => item.parent === taskId);
    } catch (error) {
      logger?.debug?.('[google] 读取子任务失败', { message: error?.message });
    }
    return { task, subtasks };
  }

  return [
    toolSpec({
      name: 'gtasks_list_tasklists',
      title: '列出 Google 任务列表',
      kind: 'read',
      description: '列出 Google Tasks 中的所有任务列表（例如「我的任务」「工作」），返回各列表的 ID 与标题。'
        + '其它 gtasks_* 工具里的 taskListId 就用这里的 ID；默认列表也可以用 @default 表示。',
      parameters: {
        maxResults: intParam('最多返回多少个列表（默认 100）'),
      },
      async run(args) {
        const response = await tasks.listTaskLists({ maxResults: clampLimit(args?.maxResults, 100, 100) });
        const items = response?.items ?? [];
        const lines = items.map((item) => `· ${item.title}  id=${item.id}${item.id === '@default' ? '（默认列表）' : ''}`);
        return {
          text: items.length === 0 ? '没有找到任务列表。' : `共 ${items.length} 个任务列表：\n${lines.join('\n')}`,
          data: { total: items.length, taskLists: items },
        };
      },
    }),

    toolSpec({
      name: 'gtasks_create_tasklist',
      title: '新建任务列表',
      kind: 'write',
      description: '创建一个新的 Google Tasks 任务列表（例如「读书清单」）。'
        + '任务列表相当于待办分类，可以在其中再放任务与子任务。',
      parameters: {
        title: stringParam('列表名称', true),
      },
      async run(args) {
        guard.assertWrite(args, '新建任务列表');
        const created = await tasks.createTaskList({ title: requireString(args, 'title') });
        return { text: `已创建任务列表「${created.title}」\nid：${created.id}`, data: created };
      },
    }),

    toolSpec({
      name: 'gtasks_update_tasklist',
      title: '重命名任务列表',
      kind: 'write',
      description: '修改任务列表的名称。列表 ID 不会改变，其中的任务与子任务也不受影响。',
      parameters: {
        taskListId: stringParam('任务列表 ID', true),
        title: stringParam('新的列表名称', true),
      },
      async run(args) {
        guard.assertWrite(args, '重命名任务列表');
        const updated = await tasks.patchTaskList(requireString(args, 'taskListId'), { title: requireString(args, 'title') });
        return { text: `已把任务列表重命名为「${updated.title}」（id：${updated.id}）`, data: updated };
      },
    }),

    toolSpec({
      name: 'gtasks_delete_tasklist',
      title: '删除任务列表',
      kind: 'danger',
      description: '永久删除一个任务列表及其中的全部任务。不可恢复，必须先获得用户同意再传 confirm: true。'
        + 'deleteTaskList 之外的列表（如默认列表）无法删除。',
      parameters: {
        taskListId: stringParam('要删除的任务列表 ID', true),
        confirm: CONFIRM_PARAM,
      },
      async run(args) {
        guard.assertWritable('删除任务列表');
        const taskListId = requireString(args, 'taskListId');
        guard.confirm(args, { action: `删除任务列表 ${taskListId}`, always: true });
        await tasks.deleteTaskList(taskListId);
        return { text: `已删除任务列表 ${taskListId}。`, data: { taskListId, deleted: true } };
      },
    }),

    toolSpec({
      name: 'gtasks_list_tasks',
      title: '查询待办任务',
      kind: 'read',
      description: '查询任务列表中的任务。taskListId 传 all 可跨所有列表合并查询，适合「我有哪些待办」这类问题。'
        + 'dueMin/dueMax 支持自然语言（「今天」「+7d」）。query 会在标题与备注中做本地关键词过滤'
        + '（Google Tasks API 本身没有搜索参数）。默认包含已完成任务。',
      parameters: {
        taskListId: stringParam('任务列表 ID；不填用默认列表；传 all 表示跨所有列表查询'),
        showCompleted: boolParam('是否包含已完成任务（默认 true）'),
        showHidden: boolParam('是否包含被隐藏的任务（默认 false）'),
        dueMin: stringParam('截止时间下限，例如「今天」「2026-10-01」'),
        dueMax: stringParam('截止时间上限，例如「+7d」「下周五」'),
        updatedMin: stringParam('只返回在此时间之后被修改过的任务'),
        maxResults: intParam('最多返回多少条（默认 100，上限 100）'),
        query: stringParam('按关键词过滤标题/备注（本地过滤）'),
        pageToken: stringParam('分页令牌'),
        timeZone: stringParam('解释自然语言时间所用时区；不填用插件配置的时区'),
      },
      async run(args) {
        const zone = timeZoneOf(args);
        const current = clock();
        const maxResults = clampLimit(args?.maxResults, 100, 100);
        const query = optionalString(args, 'query');
        const baseQuery = {
          showCompleted: args?.showCompleted !== false,
          showHidden: args?.showHidden === true ? true : undefined,
          maxResults,
          dueMin: optionalString(args, 'dueMin')
            ? toRfc3339(parseBoundary(optionalString(args, 'dueMin'), { timeZone: zone, now: current, edge: 'start' }), zone)
            : undefined,
          dueMax: optionalString(args, 'dueMax')
            ? toRfc3339(parseBoundary(optionalString(args, 'dueMax'), { timeZone: zone, now: current, edge: 'end' }), zone)
            : undefined,
          updatedMin: optionalString(args, 'updatedMin')
            ? toRfc3339(parseBoundary(optionalString(args, 'updatedMin'), { timeZone: zone, now: current, edge: 'start' }), zone)
            : undefined,
        };

        const taskListId = taskListIdOf(args);
        let collected = [];
        let names = new Map();
        let nextPageToken;

        if (taskListId === 'all' || taskListId === '*') {
          names = await listNameMap();
          for (const [id, title] of names.entries()) {
            try {
              const response = await tasks.listTasks(id, { ...baseQuery, pageToken: undefined });
              for (const task of response?.items ?? []) collected.push({ task, listId: id, listTitle: title });
            } catch (error) {
              logger?.debug?.('[google] 跨列表查询时跳过一个列表', { listId: id, message: error?.message });
            }
          }
        } else {
          const response = await tasks.listTasks(taskListId, { ...baseQuery, pageToken: optionalString(args, 'pageToken') });
          collected = (response?.items ?? []).map((task) => ({ task, listId: taskListId, listTitle: undefined }));
          nextPageToken = response?.nextPageToken;
        }

        collected = filterByQuery(collected, query);
        // 排序：未完成在前，其次按截止日期（无截止放最后），再按更新时间。
        collected.sort((a, b) => {
          const doneA = a.task.status === 'completed' ? 1 : 0;
          const doneB = b.task.status === 'completed' ? 1 : 0;
          if (doneA !== doneB) return doneA - doneB;
          const dueA = a.task.due ? Date.parse(a.task.due) : Number.MAX_SAFE_INTEGER;
          const dueB = b.task.due ? Date.parse(b.task.due) : Number.MAX_SAFE_INTEGER;
          if (dueA !== dueB) return dueA - dueB;
          return 0;
        });
        const sliced = collected.slice(0, maxResults);
        const label = query ? `匹配「${query}」的任务` : '任务';
        const head = listHeader(label, collected.length, sliced.length, collected.length > sliced.length, nextPageToken);
        const lines = sliced.map((item) => formatTaskLine(item.task, { timeZone: zone, listName: item.listTitle }));
        return {
          text: [head, ...lines].filter(Boolean).join('\n'),
          data: {
            taskListId,
            query,
            nextPageToken: typeof nextPageToken === 'string' ? nextPageToken : undefined,
            tasks: sliced.map((item) => ({ ...item.task, _taskListId: item.listId })),
          },
        };
      },
    }),

    toolSpec({
      name: 'gtasks_get_task',
      title: '读取任务详情',
      kind: 'read',
      description: '按 ID 读取单个任务的完整信息：标题、备注、截止日期、状态与父任务，并附带它的直接子任务。',
      parameters: {
        taskId: stringParam('任务 ID', true),
        taskListId: stringParam('任务所在列表 ID；不填用默认列表'),
        timeZone: stringParam('展示时间所用时区；不填用插件配置的时区'),
      },
      async run(args) {
        const zone = timeZoneOf(args);
        const taskListId = taskListIdOf(args);
        const { task, subtasks } = await fetchTaskWithChildren(taskListId, requireString(args, 'taskId'));
        const names = await listNameMap();
        return {
          text: formatTaskDetail(task, { timeZone: zone, listName: names.get(taskListId) ?? taskListId, subtasks }),
          data: { ...task, _taskListId: taskListId, subtasks },
        };
      },
    }),

    toolSpec({
      name: 'gtasks_create_task',
      title: '新建待办任务',
      kind: 'write',
      description: '创建一条待办任务。due 支持自然语言（「今天」「明天」「下周五」）。'
        + '注意 Google Tasks 的截止日期只精确到「日」，不保存具体时刻。'
        + '传入 parent（另一个任务的 ID）可创建子任务。',
      parameters: {
        title: stringParam('任务标题', true),
        notes: stringParam('备注/详细说明'),
        due: stringParam('截止日期，例如「今天」「明天」「2026-10-31」'),
        taskListId: stringParam('任务列表 ID；不填用默认列表'),
        parent: stringParam('父任务 ID，用于创建子任务'),
        previous: stringParam('排在哪个任务之后（同一列表内的任务 ID），用于排序'),
        timeZone: stringParam('解释自然语言时间所用时区；不填用插件配置的时区'),
      },
      async run(args) {
        guard.assertWrite(args, '新建任务');
        const zone = timeZoneOf(args);
        const body = { title: requireString(args, 'title') };
        if (args?.notes) body.notes = String(args.notes);
        const dueRaw = optionalString(args, 'due');
        if (dueRaw) {
          const { due, date } = dueValue(dueRaw, zone, clock());
          body.due = due;
          body._date = date;
        }
        const query = {};
        if (optionalString(args, 'parent')) query.parent = optionalString(args, 'parent');
        if (optionalString(args, 'previous')) query.previous = optionalString(args, 'previous');
        const payload = { ...body };
        delete payload._date;
        const created = await tasks.createTask(taskListIdOf(args), payload, query);
        const lines = [`已创建任务：${created.title}`, `列表：${taskListIdOf(args)}`, `id：${created.id}`];
        if (created.due) lines.push(`截止：${created.due.slice(0, 10)}`);
        if (query.parent) lines.push(`父任务：${query.parent}`);
        return { text: lines.join('\n'), data: { ...created, _taskListId: taskListIdOf(args) } };
      },
    }),

    toolSpec({
      name: 'gtasks_update_task',
      title: '修改待办任务',
      kind: 'write',
      description: '修改任务的标题、备注、截止日期或完成状态。只提交要改的字段。'
        + '用 clearDue=true 可以清除截止日期；用 status 可以标记完成/未完成（等价于 gtasks_complete_task）。',
      parameters: {
        taskId: stringParam('要修改的任务 ID', true),
        taskListId: stringParam('任务所在列表 ID；不填用默认列表'),
        title: stringParam('新的标题'),
        notes: stringParam('新的备注'),
        due: stringParam('新的截止日期（支持自然语言）'),
        clearDue: boolParam('是否清除截止日期'),
        status: enumParam(['needsAction', 'completed'], '新的完成状态：needsAction 未完成 / completed 已完成'),
        timeZone: stringParam('解释自然语言时间所用时区；不填用插件配置的时区'),
      },
      async run(args) {
        guard.assertWrite(args, '修改任务');
        const zone = timeZoneOf(args);
        const body = {};
        if (args?.title !== undefined) body.title = String(args.title);
        if (args?.notes !== undefined) body.notes = String(args.notes);
        if (optionalString(args, 'due')) body.due = dueValue(optionalString(args, 'due'), zone, clock()).due;
        if (args?.clearDue === true) body.due = null;
        if (optionalString(args, 'status')) {
          body.status = optionalString(args, 'status');
          if (body.status === 'completed') body.completed = new Date(clock()).toISOString();
        }
        if (Object.keys(body).length === 0) throw new ToolInputError('没有检测到任何要修改的字段。');
        const updated = await tasks.patchTask(taskListIdOf(args), requireString(args, 'taskId'), body);
        return {
          text: `已更新任务：${formatTaskLine(updated, { timeZone: zone })}`,
          data: { ...updated, _taskListId: taskListIdOf(args) },
        };
      },
    }),

    toolSpec({
      name: 'gtasks_complete_task',
      title: '完成/取消完成待办',
      kind: 'write',
      description: '把任务标记为已完成，或把已完成的任务恢复为未完成（completed=false）。',
      parameters: {
        taskId: stringParam('任务 ID', true),
        completed: boolParam('true 表示标记完成（默认），false 表示恢复为未完成'),
        taskListId: stringParam('任务所在列表 ID；不填用默认列表'),
      },
      async run(args) {
        guard.assertWrite(args, '更新任务完成状态');
        const done = args?.completed !== false;
        const taskListId = taskListIdOf(args);
        const taskId = requireString(args, 'taskId');
        const body = done
          ? { status: 'completed', completed: new Date(clock()).toISOString() }
          : { status: 'needsAction' };
        const updated = await tasks.patchTask(taskListId, taskId, body);
        return {
          text: done ? `已完成任务「${updated.title}」` : `已把任务「${updated.title}」恢复为未完成`,
          data: { ...updated, _taskListId: taskListId },
        };
      },
    }),

    toolSpec({
      name: 'gtasks_delete_task',
      title: '删除待办任务',
      kind: 'danger',
      description: '永久删除一条任务（及其子任务）。不可恢复，必须先获得用户同意再传 confirm: true。',
      parameters: {
        taskId: stringParam('要删除的任务 ID', true),
        taskListId: stringParam('任务所在列表 ID；不填用默认列表'),
        confirm: CONFIRM_PARAM,
      },
      async run(args) {
        guard.assertWritable('删除任务');
        const taskListId = taskListIdOf(args);
        const taskId = requireString(args, 'taskId');
        guard.confirm(args, { action: `删除任务 ${taskId}`, always: true });
        await tasks.deleteTask(taskListId, taskId);
        return { text: `已删除任务 ${taskId}（列表 ${taskListId}）。`, data: { taskId, taskListId, deleted: true } };
      },
    }),

    toolSpec({
      name: 'gtasks_move_task',
      title: '移动/重排待办任务',
      kind: 'write',
      description: '调整任务的位置：可以改父任务（移入/移出子任务）、调整同一列表内的顺序，'
        + '也可以用 destinationListId 把任务移动到另一个列表。',
      parameters: {
        taskId: stringParam('要移动的任务 ID', true),
        taskListId: stringParam('任务当前所在列表 ID；不填用默认列表'),
        destinationListId: stringParam('目标列表 ID；不填表示在同一列表内移动'),
        parent: stringParam('新的父任务 ID；不填表示移动到顶层'),
        previous: stringParam('排在哪个任务之后'),
      },
      async run(args) {
        guard.assertWrite(args, '移动任务');
        const taskListId = taskListIdOf(args);
        const query = {};
        if (optionalString(args, 'parent')) query.parent = optionalString(args, 'parent');
        if (optionalString(args, 'previous')) query.previous = optionalString(args, 'previous');
        const destination = optionalString(args, 'destinationListId');
        if (destination) query.destinationTasklist = destination;
        const moved = await tasks.moveTask(taskListId, requireString(args, 'taskId'), query);
        const target = destination ?? taskListId;
        return {
          text: [
            `已移动任务「${moved?.title ?? args.taskId}」`,
            `所在列表：${target}`,
            query.parent ? `父任务：${query.parent}` : '层级：顶层任务',
          ].join('\n'),
          data: { ...moved, _taskListId: target },
        };
      },
    }),

    toolSpec({
      name: 'gtasks_clear_completed',
      title: '清空已完成任务',
      kind: 'danger',
      description: '一次性清除某个任务列表中的所有已完成任务（Google 会隐藏它们，不可恢复）。'
        + '必须先获得用户同意再传 confirm: true。',
      parameters: {
        taskListId: stringParam('任务列表 ID；不填用默认列表'),
        confirm: CONFIRM_PARAM,
      },
      async run(args) {
        guard.assertWritable('清空已完成任务');
        const taskListId = taskListIdOf(args);
        guard.confirm(args, { action: `清空列表 ${taskListId} 中已完成的任务`, always: true });
        await tasks.clearCompleted(taskListId);
        return { text: `已清空列表 ${taskListId} 中的全部已完成任务。`, data: { taskListId, cleared: true } };
      },
    }),
  ];
}
