/**
 * 工具规格的静态校验。
 *
 * `lib/tools/*` 导出的规格最终会交给 DSH 的 `defineTool` 编译成 JSON Schema。
 * 本地测试不导入 `@deepseek-ai/dsh-tools`（工作区里没有该包），因此这里按
 * `dsh-tools/lib/types/schema.js` 的同一套作者规则复刻校验逻辑，把 schema 错误
 * 挡在「安装到 profile」之前；安装后还会再用真实工具列表复核一次。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGuard } from '../lib/guard.js';
import { epochFromParts, resolveTimeZone } from '../lib/time.js';
import { createAgendaTools } from '../lib/tools/agenda.js';
import { createAuthTools } from '../lib/tools/auth.js';
import { createCalendarTools } from '../lib/tools/calendar.js';
import { createTasksTools } from '../lib/tools/tasks.js';

/** 与 dsh-tools 一致的节点白名单。 */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);
const ALL_TYPES = new Set([...SCALAR_TYPES, 'array', 'object', 'json']);

/** 构造仅用于取规格的依赖桩（工具逻辑在别的测试里验证）。 */
function buildSpecs() {
  const config = {
    timeZone: 'Asia/Shanghai',
    defaultCalendarId: 'primary',
    defaultTaskList: '@default',
    defaultEventMinutes: 60,
    readOnly: false,
    requireConfirmForWrites: false,
  };
  const deps = {
    config,
    guard: createGuard({ config }),
    auth: {},
    flow: {},
    calendar: {},
    tasks: {},
    logger: undefined,
    timeZone: resolveTimeZone(config.timeZone, 'Asia/Shanghai'),
    epochFromParts,
    now: () => Date.parse('2026-10-05T15:49:37+08:00'),
  };
  return [
    ...createAuthTools(deps),
    ...createCalendarTools(deps),
    ...createTasksTools(deps),
    ...createAgendaTools(deps),
  ];
}

/**
 * 复刻 dsh-tools 的 value-schema 编译与作者校验，返回编译后的 JSON Schema 片段。
 *
 * @param {any} node - 参数节点。
 * @param {string} path - 出错信息里的路径。
 * @param {boolean} allowRequired - 是否允许 `required` 键（仅属性位置允许）。
 * @returns {object} 编译结果。
 */
function compileNode(node, path, allowRequired) {
  assert.ok(node && typeof node === 'object' && !Array.isArray(node), `${path} 必须是对象`);
  const allowed = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])];
  assert.ok(!Object.hasOwn(node, 'required') || node.required === true, `${path}.required 只能为 true`);

  if (Object.hasOwn(node, 'oneOf')) {
    assert.ok(!Object.hasOwn(node, 'type'), `${path} 不能同时声明 type 与 oneOf`);
    assert.ok(Array.isArray(node.oneOf) && node.oneOf.length >= 2, `${path}.oneOf 至少需要两个分支`);
    const compiled = { oneOf: node.oneOf.map((branch, index) => compileNode(branch, `${path}.oneOf[${index}]`, false)) };
    assertKeys(node, path, [...allowed, 'oneOf', 'type']);
    return compiled;
  }

  assert.ok(Object.hasOwn(node, 'type'), `${path}.type 缺失`);
  const type = node.type;
  assert.ok(ALL_TYPES.has(type), `${path}.type=${type} 不在 DSL 支持范围内`);

  if (type === 'json') {
    assertKeys(node, path, [...allowed, 'type']);
    return { json: true };
  }
  if (type === 'object') {
    assertKeys(node, path, [...allowed, 'type', 'properties', 'additionalProperties']);
    assert.equal(typeof node.additionalProperties, 'boolean', `${path}.additionalProperties 必须是显式布尔值`);
    const properties = {};
    const required = [];
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      properties[key] = compileNode(child, `${path}.properties.${key}`, true);
      if (child.required === true) required.push(key);
    }
    return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: node.additionalProperties };
  }
  if (type === 'array') {
    assertKeys(node, path, [...allowed, 'type', 'items']);
    assert.ok(Object.hasOwn(node, 'items'), `${path}.items 缺失`);
    return { type: 'array', items: compileNode(node.items, `${path}.items`, false) };
  }

  assertKeys(node, path, [...allowed, 'type', 'enum', 'const']);
  const compiled = { type };
  if (Object.hasOwn(node, 'enum')) {
    assert.ok(Array.isArray(node.enum) && node.enum.length > 0, `${path}.enum 必须是非空标量数组`);
    for (const value of node.enum) {
      assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value), `${path}.enum 含非标量值`);
    }
    compiled.enum = [...node.enum];
  }
  return compiled;
}

/** 断言节点只用到允许的键。 */
function assertKeys(node, path, allowed) {
  for (const key of Object.keys(node)) {
    assert.ok(allowed.includes(key), `${path}.${key} 不被 DSL 支持（允许：${allowed.join(', ')}）`);
  }
}

/** 把工具的 parameters 编译成完整对象 schema。 */
function compileParameters(parameters, name) {
  assert.ok(parameters && typeof parameters === 'object' && !Array.isArray(parameters), `${name}.parameters 必须是对象`);
  const properties = {};
  const required = [];
  for (const [key, node] of Object.entries(parameters)) {
    properties[key] = compileNode(node, `${name}.parameters.${key}`, true);
    if (node.required === true) required.push(key);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

const specs = buildSpecs();

test('工具数量与命名前缀符合预期', () => {
  assert.equal(specs.length, 30);
  const names = specs.map((spec) => spec.name);
  assert.equal(new Set(names).size, names.length, '工具名必须唯一');
  for (const name of names) {
    assert.match(name, /^[a-z][a-z0-9_]*$/, `工具名不合规：${name}`);
    assert.ok(
      name.startsWith('gcal_') || name.startsWith('gtasks_') || name.startsWith('google_'),
      `工具名缺少前缀：${name}`,
    );
  }
  // 四组工具都在。
  assert.ok(names.includes('google_auth_begin'));
  assert.ok(names.includes('gcal_create_event'));
  assert.ok(names.includes('gtasks_complete_task'));
  assert.ok(names.includes('google_agenda'));
});

test('每个工具都有完整的元数据', () => {
  for (const spec of specs) {
    assert.equal(typeof spec.run, 'function', `${spec.name}.run 必须是函数`);
    assert.ok(spec.description.length > 30, `${spec.name}.description 过于简短`);    assert.ok(typeof spec.title === 'string' && spec.title.length > 0, `${spec.name}.title 缺失`);
    assert.ok(['read', 'write', 'danger', 'other'].includes(spec.kind), `${spec.name}.kind 非法：${spec.kind}`);
  }
});

test('参数 schema 符合 dsh-tools 的 DSL 规则', () => {
  for (const spec of specs) {
    const schema = compileParameters(spec.parameters, spec.name);
    // required 只能引用已声明的属性。
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(schema.properties, key), `${spec.name}.required 引用了未声明属性 ${key}`);
    }
  }
});

test('删除类工具都要求 confirm 参数', () => {
  const destructive = specs.filter((spec) => spec.name.includes('delete') || spec.name === 'gtasks_clear_completed');
  assert.ok(destructive.length >= 5);
  for (const spec of destructive) {
    assert.ok(Object.hasOwn(spec.parameters, 'confirm'), `${spec.name} 缺少 confirm 参数`);
    assert.equal(spec.parameters.confirm.type, 'boolean');
  }
});

test('枚举参数都有非空枚举值', () => {
  for (const spec of specs) {
    for (const [key, node] of Object.entries(spec.parameters)) {
      if (node.enum) {
        assert.ok(Array.isArray(node.enum) && node.enum.length >= 1, `${spec.name}.${key}.enum 为空`);
        assert.equal(node.type, 'string');
      }
    }
  }
});

test('参数命名干净，没有遗留或占位参数', () => {
  for (const spec of specs) {
    for (const [key, node] of Object.entries(spec.parameters)) {
      assert.match(key, /^[a-zA-Z][a-zA-Z0-9]*$/, `${spec.name} 的参数名不合规：${key}`);
      assert.ok(!key.endsWith('_'), `${spec.name}.${key} 形似遗留占位参数`);
      const description = String(node.description ?? '');
      assert.ok(description.length > 0, `${spec.name}.${key} 缺少参数说明`);
      assert.doesNotMatch(description, /内部保留|占位|TODO|FIXME/, `${spec.name}.${key} 的参数说明仍是占位内容`);
    }
  }
});

test('每个工具的输出契约一致（text + data）', async () => {
  // 逐一带参调用全部只读工具，验证它们都返回 { text, data }。
  const { createHarness } = await import('./harness.mjs');
  const harness = await createHarness({});
  try {
    harness.mock.putEvent('primary', {
      id: 'evt-lint',
      summary: '用于契约校验的日程',
      start: { dateTime: '2026-10-06T15:00:00+08:00' },
      end: { dateTime: '2026-10-06T16:00:00+08:00' },
    });
    harness.mock.putTask('@default', { id: 'task-lint', title: '用于契约校验的任务', status: 'needsAction' });

    const argsByTool = {
      gcal_get_event: { eventId: 'evt-lint' },
      gcal_find_free_slots: { timeMin: '今天', timeMax: '明天' },
      gtasks_get_task: { taskId: 'task-lint' },
    };
    const readOnlyTools = specs.filter((spec) => spec.kind === 'read').map((spec) => spec.name);
    assert.ok(readOnlyTools.length >= 8, `只读工具数量偏少：${readOnlyTools.length}`);

    for (const name of readOnlyTools) {
      const result = await harness.call(name, argsByTool[name] ?? {});
      assert.equal(typeof result.text, 'string', `${name} 未返回 text`);
      assert.ok(result.text.length > 0, `${name} 返回了空 text`);
      assert.ok(Object.hasOwn(result, 'data'), `${name} 未返回 data`);
    }
  } finally {
    await harness.close();
  }
});

test('工具返回的 data 经规整后必须是无损 JSON', async () => {
  // DSH 会以 `value is not lossless JSON` 拒绝含 undefined / NaN 的输出。
  // 这条回归测试覆盖了历史上真实踩到过的坑：gcal_list_events 与
  // gtasks_list_tasks 用 `cond ? value : undefined` 表达可选字段。
  const { createHarness } = await import('./harness.mjs');
  const { toLosslessJson, isLosslessJson } = await import('../lib/json.js');
  const harness = await createHarness({});
  try {
    harness.mock.putEvent('primary', {
      id: 'evt-json',
      summary: 'JSON 校验日程',
      start: { dateTime: '2026-10-06T15:00:00+08:00' },
      end: { dateTime: '2026-10-06T16:00:00+08:00' },
    });
    harness.mock.putTask('@default', { id: 'task-json', title: 'JSON 校验任务', status: 'needsAction' });

    const cases = [
      ['gcal_list_events', {}],
      ['gcal_list_events', { calendarId: 'all', timeMin: '今天', timeMax: '明天' }],
      ['gcal_list_calendars', {}],
      ['gcal_get_event', { eventId: 'evt-json' }],
      ['gcal_find_free_slots', { timeMin: '今天', timeMax: '明天' }],
      ['gtasks_list_tasks', {}],
      ['gtasks_list_tasks', { taskListId: 'all' }],
      ['gtasks_list_tasklists', {}],
      ['gtasks_get_task', { taskId: 'task-json' }],
      ['google_agenda', {}],
      ['google_auth_status', { verify: false }],
    ];

    for (const [name, args] of cases) {
      const result = await harness.call(name, args);
      const sanitized = toLosslessJson(result.data ?? null);
      const verdict = isLosslessJson(sanitized);
      assert.ok(verdict.ok, `${name} 的 data 不是无损 JSON：${verdict.detail}`);
      // 规整必须是幂等的，避免反复调用时数据漂移。
      assert.deepEqual(toLosslessJson(sanitized), sanitized, `${name} 的规整不幂等`);
    }
  } finally {
    await harness.close();
  }
});

test('toLosslessJson 处理各类边界值', async () => {
  const { toLosslessJson, isLosslessJson } = await import('../lib/json.js');

  assert.deepEqual(toLosslessJson({ a: undefined, b: 1, c: null }), { b: 1, c: null });
  assert.deepEqual(toLosslessJson([1, undefined, 2]), [1, null, 2]);
  assert.deepEqual(toLosslessJson({ n: Number.NaN, i: Number.POSITIVE_INFINITY }), { n: null, i: null });
  assert.deepEqual(toLosslessJson({ d: new Date('2026-10-06T15:00:00.000Z') }), { d: '2026-10-06T15:00:00.000Z' });
  assert.deepEqual(toLosslessJson({ f: () => {}, s: Symbol('x') }), { f: null, s: null });
  assert.deepEqual(toLosslessJson({ nested: { deep: undefined, keep: 'v' } }), { nested: { keep: 'v' } });
  assert.equal(toLosslessJson(undefined), null);

  assert.equal(isLosslessJson({ a: 1, b: [1, 2], c: { d: null } }).ok, true);
  assert.equal(isLosslessJson({ a: undefined }).ok, false);
  assert.equal(isLosslessJson({ a: Number.NaN }).ok, false);
  assert.equal(isLosslessJson({ a: new Date() }).ok, false);
});
