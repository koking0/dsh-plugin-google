/**
 * `lib/time.js` 的单元测试：时区换算与自然语言时间解析。
 *
 * 固定「现在」为 2026-10-05（周一）15:49:37 +08:00，使断言与真实时钟无关。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addDays,
  epochFromParts,
  formatDateTimeLabel,
  parseBoundary,
  parseDurationMinutes,
  parsePeriodDefault,
  parseTimeToken,
  parseWhen,
  partsInZone,
  resolveRangePreset,
  resolveTimeZone,
  TimeParseError,
  toRfc3339,
} from '../lib/time.js';

const TZ = 'Asia/Shanghai';
const NOW = Date.parse('2026-10-05T15:49:37+08:00');
const opts = { timeZone: TZ, now: NOW };

test('partsInZone 给出东八区的墙上时间', () => {
  const parts = partsInZone(NOW, TZ);
  assert.deepEqual(
    { y: parts.year, m: parts.month, d: parts.day, h: parts.hour, mi: parts.minute, wd: parts.weekday },
    { y: 2026, m: 10, d: 5, h: 15, mi: 49, wd: 1 },
  );
});

test('resolveTimeZone 校验非法时区', () => {
  assert.equal(resolveTimeZone('Asia/Shanghai'), 'Asia/Shanghai');
  assert.equal(resolveTimeZone('Not/AZone', 'Asia/Shanghai'), 'Asia/Shanghai');
  assert.equal(resolveTimeZone(undefined, 'UTC'), 'UTC');
});

test('epochFromParts 与 toRfc3339 往返一致', () => {
  const epoch = epochFromParts({ year: 2026, month: 10, day: 6, hour: 15, minute: 0, second: 0 }, TZ);
  assert.equal(toRfc3339(epoch, TZ), '2026-10-06T15:00:00+08:00');
  assert.equal(formatDateTimeLabel(epoch, TZ), '2026-10-06 周二 15:00');
});

test('addDays 跨月与跨年', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('关键词日期', () => {
  assert.deepEqual(parseWhen('今天', opts).date, '2026-10-05');
  assert.deepEqual(parseWhen('明天', opts).date, '2026-10-06');
  assert.deepEqual(parseWhen('后天', opts).date, '2026-10-07');
  assert.deepEqual(parseWhen('大后天', opts).date, '2026-10-08');
  assert.deepEqual(parseWhen('昨天', opts).date, '2026-10-04');
  assert.deepEqual(parseWhen('前天', opts).date, '2026-10-03');
  assert.deepEqual(parseWhen('tomorrow', opts).date, '2026-10-06');
});

test('星期表达（今天是周一）', () => {
  assert.deepEqual(parseWhen('周五', opts).date, '2026-10-09');
  assert.deepEqual(parseWhen('星期日', opts).date, '2026-10-11');
  assert.deepEqual(parseWhen('下周一', opts).date, '2026-10-12');
  assert.deepEqual(parseWhen('上周五', opts).date, '2026-10-02');
  assert.deepEqual(parseWhen('下周三 10:00', opts).kind, 'dateTime');
});

test('中文时间表达', () => {
  assert.equal(formatDateTimeLabel(parseWhen('明天下午3点', opts).epochMs, TZ), '2026-10-06 周二 15:00');
  assert.equal(formatDateTimeLabel(parseWhen('明天上午9点半', opts).epochMs, TZ), '2026-10-06 周二 09:30');
  assert.equal(formatDateTimeLabel(parseWhen('2026年10月6日 15:00', opts).epochMs, TZ), '2026-10-06 周二 15:00');
  assert.equal(formatDateTimeLabel(parseWhen('明天 8:05', opts).epochMs, TZ), '2026-10-06 周二 08:05');
  assert.equal(formatDateTimeLabel(parseWhen('晚上8点', opts).epochMs, TZ), '2026-10-05 周一 20:00');
  assert.equal(formatDateTimeLabel(parseWhen('中午12点', opts).epochMs, TZ), '2026-10-05 周一 12:00');
  assert.equal(formatDateTimeLabel(parseWhen('凌晨1点', opts).epochMs, TZ), '2026-10-05 周一 01:00');
});

test('时段缩写带默认时刻并标记 assumed', () => {
  const tonight = parseWhen('今晚', opts);
  assert.equal(tonight.assumed, true);
  assert.equal(formatDateTimeLabel(tonight.epochMs, TZ), '2026-10-05 周一 19:00');

  const tomorrowEvening = parseWhen('明晚8点', opts);
  assert.equal(tomorrowEvening.assumed, undefined);
  assert.equal(formatDateTimeLabel(tomorrowEvening.epochMs, TZ), '2026-10-06 周二 20:00');

  const tomorrowAfternoon = parseWhen('明天下午', opts);
  assert.equal(tomorrowAfternoon.assumed, true);
  assert.equal(formatDateTimeLabel(tomorrowAfternoon.epochMs, TZ), '2026-10-06 周二 14:00');
});

test('纯时间按今天解释', () => {
  assert.equal(formatDateTimeLabel(parseWhen('15:00', opts).epochMs, TZ), '2026-10-05 周一 15:00');
  assert.equal(formatDateTimeLabel(parseWhen('9:05', opts).epochMs, TZ), '2026-10-05 周一 09:05');
});

test('带偏移的 ISO 是绝对时刻', () => {
  const parsed = parseWhen('2026-10-06T15:00:00+08:00', opts);
  assert.equal(parsed.kind, 'dateTime');
  assert.equal(parsed.epochMs, Date.parse('2026-10-06T15:00:00+08:00'));
  // 同一时刻在 UTC 会话里表示的墙上时间不同，但绝对时刻不变。
  assert.equal(parseWhen('2026-10-06T07:00:00Z', opts).epochMs, parsed.epochMs);
});

test('日期表达返回 all-day 形态', () => {
  assert.deepEqual(parseWhen('2026-10-06', opts), {
    kind: 'date', date: '2026-10-06', timeZone: TZ, text: '2026-10-06',
  });
  assert.deepEqual(parseWhen('10月6日', opts).date, '2026-10-06');
  assert.deepEqual(parseWhen('10月6号', opts).date, '2026-10-06');
});

test('相对量', () => {
  assert.equal(parseWhen('+2h', opts).epochMs, NOW + 7200000);
  assert.equal(parseWhen('now+90m', opts).epochMs, NOW + 5400000);
  assert.equal(parseWhen('3天后', opts).epochMs, NOW + 3 * 86400000);
  assert.equal(parseWhen('2小时前', opts).epochMs, NOW - 2 * 3600000);
  assert.equal(parseWhen('now', opts).epochMs, NOW);
});

test('英文表达', () => {
  assert.equal(formatDateTimeLabel(parseWhen('tomorrow 15:00', opts).epochMs, TZ), '2026-10-06 周二 15:00');
  assert.equal(formatDateTimeLabel(parseWhen('friday 09:00', opts).epochMs, TZ), '2026-10-09 周五 09:00');
  assert.deepEqual(parseWhen('next monday', opts).date, '2026-10-12');
});

test('parseBoundary 按天补齐边界', () => {
  const start = parseBoundary('今天', { ...opts, edge: 'start' });
  const end = parseBoundary('今天', { ...opts, edge: 'end' });
  assert.equal(formatDateTimeLabel(start, TZ), '2026-10-05 周一 00:00');
  assert.equal(end - start, 86400000 - 1);
  // 已是绝对时刻时原样返回。
  assert.equal(parseBoundary('2026-10-06T15:00:00+08:00', { ...opts, edge: 'start' }), Date.parse('2026-10-06T15:00:00+08:00'));
});

test('非法表达抛出可读错误', () => {
  assert.throws(() => parseWhen('随便什么时候', opts), TimeParseError);
  assert.throws(() => parseWhen('', opts), TimeParseError);
  assert.throws(() => parseWhen('2026-10-06 25:99', opts), TimeParseError);
});

test('parseTimeToken / parseDurationMinutes / parsePeriodDefault', () => {
  assert.deepEqual(parseTimeToken('下午3点'), { hour: 15, minute: 0 });
  assert.deepEqual(parseTimeToken('23:45'), { hour: 23, minute: 45 });
  assert.equal(parseTimeToken('下午'), undefined);
  assert.equal(parseDurationMinutes('1h30m'), 90);
  assert.equal(parseDurationMinutes('45'), 45);
  assert.equal(parseDurationMinutes('2小时'), 120);
  assert.equal(parseDurationMinutes('abc'), undefined);
  assert.equal(parsePeriodDefault('下午').hour, 14);
  assert.equal(parsePeriodDefault('随便'), undefined);
});

test('resolveRangePreset 覆盖今天/本周', () => {
  const today = resolveRangePreset('today', TZ, NOW);
  assert.equal(formatDateTimeLabel(today.start, TZ), '2026-10-05 周一 00:00');
  assert.equal(today.end - today.start, 86400000 - 1);

  const week = resolveRangePreset('week', TZ, NOW);
  assert.equal(formatDateTimeLabel(week.start, TZ), '2026-10-05 周一 00:00');
  assert.equal(week.end - week.start, 7 * 86400000 - 1);
});
