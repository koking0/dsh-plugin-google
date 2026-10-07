/**
 * Tasks 工具的行为测试：列表与任务的增删改查、完成状态、子任务、跨列表移动与清理。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHarness } from './harness.mjs';

async function withHarness(options, fn) {
  const harness = await createHarness(options);
  try {
    await fn(harness);
  } finally {
    await harness.close();
  }
}

test('gtasks_list_tasklists 返回任务列表', async () => {
  await withHarness({}, async (h) => {
    const result = await h.call('gtasks_list_tasklists', {});
    assert.equal(result.data.total, 2);
    assert.match(result.text, /我的任务/);
    assert.match(result.text, /工作待办/);
    assert.match(result.text, /@default/);
  });
});

test('任务列表的增删改', async () => {
  await withHarness({}, async (h) => {
    const created = await h.call('gtasks_create_tasklist', { title: '读书清单' });
    assert.equal(created.data.title, '读书清单');
    const listId = created.data.id;

    const renamed = await h.call('gtasks_update_tasklist', { taskListId: listId, title: '读书计划' });
    assert.equal(renamed.data.title, '读书计划');

    await assert.rejects(() => h.call('gtasks_delete_tasklist', { taskListId: listId }), /需要二次确认/);
    await h.call('gtasks_delete_tasklist', { taskListId: listId, confirm: true });
    assert.equal(h.mock.state.taskLists.has(listId), false);
  });
});

test('gtasks_create_task 用自然语言设置截止日期且只保留日期', async () => {
  await withHarness({}, async (h) => {
    const result = await h.call('gtasks_create_task', { title: '写周报', due: '明天' });
    const created = [...h.mock.state.tasks.get('@default').values()][0];
    // 服务端只看日期：统一写成该日期的 UTC 零点，避免时区把日期推前推后。
    assert.equal(created.due, '2026-10-06T00:00:00.000Z');
    assert.equal(created.status, 'needsAction');
    // 展示时按日期部分渲染。
    assert.match(result.text, /2026-10-06/);
  });
  await withHarness({}, async (h) => {
    await h.call('gtasks_create_task', { title: '月度复盘', due: '2026-10-31' });
    const created = [...h.mock.state.tasks.get('@default').values()][0];
    assert.equal(created.due, '2026-10-31T00:00:00.000Z');
  });
});

test('gtasks_create_task 支持备注、指定列表与子任务', async () => {
  await withHarness({}, async (h) => {
    const parent = await h.call('gtasks_create_task', { title: '季度总结', taskListId: 'list0001', notes: '包含数据复盘' });
    const child = await h.call('gtasks_create_task', { title: '收集数据', taskListId: 'list0001', parent: parent.data.id });
    const stored = h.mock.state.tasks.get('list0001').get(child.data.id);
    assert.equal(stored.parent, parent.data.id);
    assert.equal(h.mock.state.tasks.get('list0001').get(parent.data.id).notes, '包含数据复盘');
  });
});

test('gtasks_list_tasks 过滤、排序与跨列表查询', async () => {
  await withHarness({}, async (h) => {
    h.mock.putTask('@default', { title: '买牛奶', due: '2026-10-06T00:00:00.000Z', status: 'needsAction' });
    h.mock.putTask('@default', { title: '已完成的旧任务', due: '2026-10-04T00:00:00.000Z', status: 'completed', completed: '2026-10-04T09:00:00.000Z' });
    h.mock.putTask('list0001', { title: '写周报', due: '2026-10-05T00:00:00.000Z', status: 'needsAction' });
    h.mock.putTask('list0001', { title: '无期限任务', status: 'needsAction' });

    const all = await h.call('gtasks_list_tasks', { taskListId: 'all' });
    assert.equal(all.data.tasks.length, 4);
    // 未完成在前，其次按截止日期升序，无截止的最后。
    assert.deepEqual(all.data.tasks.map((task) => task.title), ['写周报', '买牛奶', '无期限任务', '已完成的旧任务']);

    const filtered = await h.call('gtasks_list_tasks', { taskListId: 'all', query: '周报' });
    assert.equal(filtered.data.tasks.length, 1);
    assert.equal(filtered.data.tasks[0].title, '写周报');

    const pending = await h.call('gtasks_list_tasks', { taskListId: 'all', showCompleted: false });
    assert.equal(pending.data.tasks.length, 3);

    const scoped = await h.call('gtasks_list_tasks', { taskListId: 'list0001' });
    assert.equal(scoped.data.tasks.length, 2);

    const byDue = await h.call('gtasks_list_tasks', { taskListId: 'all', dueMax: '2026-10-05' });
    assert.deepEqual(byDue.data.tasks.map((task) => task.title).sort(), ['写周报', '已完成的旧任务']);
  });
});

test('gtasks_complete_task 标记完成与恢复未完成', async () => {
  await withHarness({}, async (h) => {
    const created = await h.call('gtasks_create_task', { title: '提交报销' });
    const taskId = created.data.id;

    const done = await h.call('gtasks_complete_task', { taskId });
    assert.match(done.text, /已完成任务/);
    assert.equal(h.mock.state.tasks.get('@default').get(taskId).status, 'completed');

    const undone = await h.call('gtasks_complete_task', { taskId, completed: false });
    assert.match(undone.text, /恢复为未完成/);
    const stored = h.mock.state.tasks.get('@default').get(taskId);
    assert.equal(stored.status, 'needsAction');
    assert.equal(stored.completed, undefined);
  });
});

test('gtasks_update_task 支持改字段、清空截止日期与改状态', async () => {
  await withHarness({}, async (h) => {
    const created = await h.call('gtasks_create_task', { title: '旧标题', due: '明天' });
    const taskId = created.data.id;

    const updated = await h.call('gtasks_update_task', { taskId, title: '新标题', notes: '补充说明', due: '下周一' });
    assert.equal(updated.data.title, '新标题');
    assert.equal(updated.data.notes, '补充说明');
    assert.equal(updated.data.due, '2026-10-12T00:00:00.000Z');

    const cleared = await h.call('gtasks_update_task', { taskId, clearDue: true });
    assert.equal(cleared.data.due, undefined);

    const completed = await h.call('gtasks_update_task', { taskId, status: 'completed' });
    assert.equal(completed.data.status, 'completed');

    await assert.rejects(() => h.call('gtasks_update_task', { taskId }), /没有检测到任何要修改的字段/);
  });
});

test('gtasks_move_task 支持改父任务与跨列表移动', async () => {
  await withHarness({}, async (h) => {
    const parent = await h.call('gtasks_create_task', { title: '父任务' });
    const child = await h.call('gtasks_create_task', { title: '子任务' });

    const nested = await h.call('gtasks_move_task', { taskId: child.data.id, parent: parent.data.id });
    assert.match(nested.text, /父任务/);
    assert.equal(h.mock.state.tasks.get('@default').get(child.data.id).parent, parent.data.id);

    const crossList = await h.call('gtasks_move_task', {
      taskId: child.data.id,
      destinationListId: 'list0001',
      // 跨列表时不应保留原父任务。
    });
    assert.match(crossList.text, /工作待办|list0001/);
    assert.equal(h.mock.state.tasks.get('@default').has(child.data.id), false);
    assert.equal(h.mock.state.tasks.get('list0001').has(child.data.id), true);
  });
});

test('gtasks_delete_task 需要二次确认', async () => {
  await withHarness({}, async (h) => {
    const created = await h.call('gtasks_create_task', { title: '待删' });
    const taskId = created.data.id;
    await assert.rejects(() => h.call('gtasks_delete_task', { taskId }), /需要二次确认/);
    assert.equal(h.mock.state.tasks.get('@default').size, 1);
    await h.call('gtasks_delete_task', { taskId, confirm: true });
    assert.equal(h.mock.state.tasks.get('@default').size, 0);
  });
});

test('gtasks_get_task 返回子任务', async () => {
  await withHarness({}, async (h) => {
    const parent = await h.call('gtasks_create_task', { title: '父任务' });
    await h.call('gtasks_create_task', { title: '子任务 A', parent: parent.data.id });
    await h.call('gtasks_create_task', { title: '子任务 B', parent: parent.data.id });

    const result = await h.call('gtasks_get_task', { taskId: parent.data.id });
    assert.match(result.text, /子任务（2）/);
    assert.match(result.text, /子任务 A/);
    assert.match(result.text, /子任务 B/);
    assert.equal(result.data.subtasks.length, 2);
  });
});

test('gtasks_clear_completed 清空已完成任务且需确认', async () => {
  await withHarness({}, async (h) => {
    await h.call('gtasks_create_task', { title: '未完成' });
    const done = await h.call('gtasks_create_task', { title: '已完成' });
    await h.call('gtasks_complete_task', { taskId: done.data.id });

    await assert.rejects(() => h.call('gtasks_clear_completed', {}), /需要二次确认/);
    const result = await h.call('gtasks_clear_completed', { confirm: true });
    assert.match(result.text, /已清空/);

    const remaining = [...h.mock.state.tasks.get('@default').values()];
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].title, '未完成');
  });
});

test('只读模式下任务写入被拒绝', async () => {
  await withHarness({ config: { readOnly: true } }, async (h) => {
    await assert.rejects(() => h.call('gtasks_create_task', { title: 'x' }), /只读模式/);
    await assert.rejects(() => h.call('gtasks_complete_task', { taskId: 'x' }), /只读模式/);
    const list = await h.call('gtasks_list_tasks', {});
    assert.match(list.text, /未找到|任务/);
  });
});

test('任务不存在时给出可读错误', async () => {
  await withHarness({}, async (h) => {
    await assert.rejects(() => h.call('gtasks_get_task', { taskId: 'nope' }), /未找到任务/);
  });
});
