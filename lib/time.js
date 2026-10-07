/**
 * 时区与自然语言时间解析。
 *
 * Google Calendar 只接受 RFC 3339 时间戳或 `YYYY-MM-DD` 日期，而对话里出现的
 * 往往是「明天下午3点」「下周一上午10点」「+2h」这类表达。本模块负责：
 *
 * - 不依赖任何第三方库，用 `Intl.DateTimeFormat` 完成 IANA 时区与 UTC 的换算；
 * - 把自然语言时间解析为 `{ kind: 'date' | 'dateTime' }`；解析失败时抛出可读错误，
 *   让模型知道支持哪些写法并自行纠正；
 * - 生成给模型看的中文时间描述。
 *
 * @module dsh-plugin-google/lib/time
 */

/** 中文星期简写，索引为 `Date.getUTCDay()`。 */
export const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 中文星期全称。 */
export const WEEKDAY_ZH_FULL = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

const formatterCache = new Map();

/** 时间解析失败；携带面向模型的提示。 */
export class TimeParseError extends Error {
  /**
   * @param {string} message - 中文说明。
   * @param {string} input - 原始输入。
   */
  constructor(message, input) {
    super(message);
    this.name = 'TimeParseError';
    this.input = input;
  }
}

/** 常用写法提示，附在所有解析失败信息后。 */
const SYNTAX_HINT = '支持：ISO 时间（2026-10-06T15:00:00+08:00）、'
  + '日期（2026-10-06 / 2026年10月6日）、'
  + '关键词（今天/明天/后天/昨天/下周一/下周三 等 + 可选时间）、'
  + '时间（15:00 / 下午3点 / 上午9点半）、'
  + '相对量（+2h / +90m / +3d / 3天后 / 2小时前）、now。';

function getFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * 校验 IANA 时区名是否可用；不可用时回退。
 * @param {string|undefined} timeZone - 候选时区。
 * @param {string} [fallback] - 回退时区。
 * @returns {string} 可用时区名。
 */
export function resolveTimeZone(timeZone, fallback = 'UTC') {
  const candidates = [timeZone, fallback, 'UTC'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: candidate });
      return candidate;
    } catch {
      // 继续尝试下一个候选。
    }
  }
  return 'UTC';
}

/**
 * 把某个时刻转换为指定时区的日历字段。
 * @param {number} epochMs - 毫秒时间戳。
 * @param {string} timeZone - IANA 时区。
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number,weekday:number}} 日历字段。
 */
export function partsInZone(epochMs, timeZone) {
  const parts = getFormatter(timeZone).formatToParts(new Date(epochMs));
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  return {
    year,
    month,
    day,
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/**
 * 求某时刻在该时区的 UTC 偏移（毫秒）。东八区返回 +8h。
 * @param {number} epochMs - 毫秒时间戳。
 * @param {string} timeZone - IANA 时区。
 * @returns {number} 偏移毫秒数。
 */
export function offsetMsAt(epochMs, timeZone) {
  const p = partsInZone(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(epochMs / 1000) * 1000;
  return asUtc - truncated;
}

/**
 * 把指定时区的墙上时间转换为毫秒时间戳（两轮迭代即可跨过 DST 边界）。
 * @param {{year:number,month:number,day:number,hour?:number,minute?:number,second?:number}} parts - 墙上时间。
 * @param {string} timeZone - IANA 时区。
 * @returns {number} 毫秒时间戳。
 */
export function epochFromParts(parts, timeZone) {
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  let epoch = asUtc - offsetMsAt(asUtc, timeZone);
  epoch = asUtc - offsetMsAt(epoch, timeZone);
  return epoch;
}

/** 两位补零。 */
function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/**
 * 生成 `YYYY-MM-DD`。
 * @param {{year:number,month:number,day:number}} parts - 日历字段。
 * @returns {string} 日期字符串。
 */
export function toDateString(parts) {
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * 生成 `HH:MM`。
 * @param {{hour:number,minute:number}} parts - 日历字段。
 * @returns {string} 时间字符串。
 */
export function toTimeString(parts) {
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

/**
 * 生成带偏移的 RFC 3339 字符串，例如 `2026-10-06T15:00:00+08:00`。
 * @param {number} epochMs - 毫秒时间戳。
 * @param {string} timeZone - IANA 时区。
 * @returns {string} RFC 3339 字符串。
 */
export function toRfc3339(epochMs, timeZone) {
  const p = partsInZone(epochMs, timeZone);
  const offset = offsetMsAt(epochMs, timeZone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const offsetText = `${sign}${pad(Math.floor(abs / 3600000))}:${pad(Math.floor((abs % 3600000) / 60000))}`;
  return `${toDateString(p)}T${toTimeString(p)}:${pad(p.second)}${offsetText}`;
}

/**
 * 给模型看的时间描述：`2026-10-06 周二 15:00`。
 * @param {number} epochMs - 毫秒时间戳。
 * @param {string} timeZone - IANA 时区。
 * @returns {string} 可读文本。
 */
export function formatDateTimeLabel(epochMs, timeZone) {
  const p = partsInZone(epochMs, timeZone);
  return `${toDateString(p)} ${WEEKDAY_ZH[p.weekday]} ${toTimeString(p)}`;
}

/**
 * 给模型看的日期描述：`2026-10-06 周二`。
 * @param {string} date - `YYYY-MM-DD`。
 * @returns {string} 可读文本。
 */
export function formatDateLabel(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${date} ${WEEKDAY_ZH[weekday]}`;
}

/**
 * 相对「现在」的中文描述，例如 `3 天后`、`2 小时前`。
 * @param {number} epochMs - 目标时刻。
 * @param {number} now - 当前时刻。
 * @returns {string} 可读文本。
 */
export function formatRelative(epochMs, now = Date.now()) {
  const diff = epochMs - now;
  const abs = Math.abs(diff);
  const unit = abs < 60000 ? [Math.round(abs / 1000), '秒']
    : abs < 3600000 ? [Math.round(abs / 60000), '分钟']
      : abs < 86400000 ? [Math.round(abs / 3600000), '小时']
        : [Math.round(abs / 86400000), '天'];
  if (unit[0] === 0) return '现在';
  return `${unit[0]} ${unit[1]}${diff >= 0 ? '后' : '前'}`;
}

/**
 * 日期字符串加减天数。
 * @param {string} date - `YYYY-MM-DD`。
 * @param {number} days - 增量天数。
 * @returns {string} 新日期。
 */
export function addDays(date, days) {
  const [year, month, day] = String(date).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * 把 `YYYY-MM-DD` 解析为日历字段。
 * @param {string} date - 日期字符串。
 * @returns {{year:number,month:number,day:number}} 日历字段。
 */
export function parseDateParts(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  return { year, month, day };
}

/**
 * 解析时长：`90m`、`1h30m`、`2h`、`45`（分钟）等。
 * @param {string|number} value - 时长表达。
 * @returns {number|undefined} 分钟数；无法解析时为 undefined。
 */
export function parseDurationMinutes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text);
  const pattern = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|小时|时|m|min|mins|minute|minutes|分钟|分)/g;
  let total = 0;
  let matched = false;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2];
    total += /^h/.test(unit) || unit === '小时' || unit === '时' ? amount * 60 : amount;
  }
  if (!matched) return undefined;
  return Math.round(total);
}

/** 把全角字符与中文标点归一化为半角，便于统一正则。 */
function normalizeText(value) {
  return String(value ?? '')
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\uFF1A]/g, ':')
    .replace(/[\uFF0B]/g, '+')
    .replace(/[\uFF0D]/g, '-')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 中文数字转阿拉伯数字（支持 0-99 的常见写法）。 */
function chineseNumber(text) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (/^\d+$/.test(text)) return Number(text);
  if (!text) return NaN;
  if (text === '十') return 10;
  const tenIndex = text.indexOf('十');
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digits[text[tenIndex - 1]];
    const ones = tenIndex === text.length - 1 ? 0 : digits[text[tenIndex + 1]];
    if (tens === undefined || ones === undefined) return NaN;
    return tens * 10 + ones;
  }
  return digits[text];
}

/** 时段词对小时数的修正。 */
const PERIODS = [
  { pattern: /凌晨|半夜|深夜/, apply: (hour) => hour },
  { pattern: /早上|早晨|清晨|上午|am/, apply: (hour) => (hour === 12 ? 0 : hour) },
  { pattern: /中午|正午/, apply: (hour) => (hour < 11 ? hour + 12 : hour) },
  { pattern: /下午|傍晚|pm/, apply: (hour) => (hour < 12 ? hour + 12 : hour) },
  { pattern: /晚上|夜里|晚间/, apply: (hour) => (hour < 12 ? hour + 12 : hour) },
];

/**
 * 从文本中解析「时间」部分。
 * @param {string} text - 形如 `下午3点`、`15:00`、`9点半`、`at 8pm`。
 * @returns {{hour:number,minute:number}|undefined} 时间；不存在时为 undefined。
 */
export function parseTimeToken(text) {
  let source = normalizeText(text).toLowerCase();
  if (!source) return undefined;
  const period = PERIODS.find((item) => item.pattern.test(source));
  source = source.replace(/凌晨|半夜|深夜|早上|早晨|清晨|上午|中午|正午|下午|傍晚|晚上|夜里|晚间|at\b/g, ' ').trim();

  let hour;
  let minute = 0;
  let matched = false;

  // 15:30 / 9:05
  let match = /(\d{1,2}):(\d{2})/.exec(source);
  if (match) {
    hour = Number(match[1]);
    minute = Number(match[2]);
    matched = true;
  } else {
    // 3点 / 3点半 / 3点30 / 3时 / 十五点
    match = /([0-9]{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*[点時时](?:\s*(半|[0-9]{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*分?)?/.exec(source);
    if (match) {
      hour = chineseNumber(match[1]);
      matched = true;
      if (match[2]) {
        minute = match[2] === '半' ? 30 : chineseNumber(match[2]);
      }
    } else if (period) {
      // 只有时段词如「下午」时无意义，忽略。
      match = /(\d{1,2})\s*(?:am|pm)/.exec(source);
      if (match) {
        hour = Number(match[1]);
        matched = true;
        if (/pm/.test(source) && hour < 12) hour += 12;
        if (/am/.test(source) && hour === 12) hour = 0;
      }
    }
  }

  if (!matched || !Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  if (period && !/am|pm/.test(source)) hour = period.apply(hour);
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}

/** 中文星期字 → `Date.getUTCDay()` 值。 */
const WEEKDAY_CHAR_INDEX = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

/** 英文星期名 → `Date.getUTCDay()` 值。 */
const WEEKDAY_EN = [
  [/^(?:sun|sunday)$/, 0],
  [/^(?:mon|monday)$/, 1],
  [/^(?:tue|tues|tuesday)$/, 2],
  [/^(?:wed|wednesday)$/, 3],
  [/^(?:thu|thur|thurs|thursday)$/, 4],
  [/^(?:fri|friday)$/, 5],
  [/^(?:sat|saturday)$/, 6],
];

/** 天偏移关键词（起始锚定，允许后接时刻）→ 相对今天的天数。 */
const DAY_WORDS = [
  { re: /^(?:day after tomorrow|后天|後天)/, days: 2 },
  { re: /^(?:大后天)/, days: 3 },
  { re: /^(?:today|今天|今日)/, days: 0 },
  { re: /^(?:tomorrow|明天|明日)/, days: 1 },
  { re: /^(?:yesterday|昨天|昨日)/, days: -1 },
  { re: /^(?:前天)/, days: -2 },
];

/** 中文时段缩写（「今晚」= 今天 + 晚上），语义上已含时刻倾向。 */
const DAY_CONTRACTIONS = [
  { re: /^今(?:晚|夜)/, days: 0, period: '晚上', hour: 19 },
  { re: /^明(?:早|晨)/, days: 1, period: '早上', hour: 8 },
  { re: /^明(?:晚|夜)/, days: 1, period: '晚上', hour: 19 },
  { re: /^昨(?:晚|夜)/, days: -1, period: '晚上', hour: 19 },
];

/** 只有时段词（无具体钟点）时的默认时刻。 */
const PERIOD_DEFAULTS = [
  { re: /凌晨|半夜|深夜/, hour: 1 },
  { re: /早上|早晨|清晨|上午|morning/, hour: 9 },
  { re: /中午|正午|noon/, hour: 12 },
  { re: /下午|afternoon/, hour: 14 },
  { re: /傍晚/, hour: 18 },
  { re: /晚上|夜里|晚间|tonight|evening/, hour: 19 },
];

/**
 * 只有时段词时给出默认钟点（解析结果会标记 `assumed`，由工具层向用户说明）。
 * @param {string} text - 输入文本。
 * @returns {{hour:number,minute:number,label:string}|undefined} 默认时刻。
 */
export function parsePeriodDefault(text) {
  const source = normalizeText(text).toLowerCase();
  if (!source) return undefined;
  for (const item of PERIOD_DEFAULTS) {
    const hit = item.re.exec(source);
    if (hit) return { hour: item.hour, minute: 0, label: hit[0] };
  }
  return undefined;
}

/**
 * 解析一个时间表达。
 *
 * @param {string} input - 用户/模型给出的时间表达。
 * @param {object} [options] - 解析上下文。
 * @param {string} [options.timeZone] - 解释「墙上时间」所用时区。
 * @param {number} [options.now] - 当前毫秒时间戳（便于测试）。
 * @param {'start'|'end'|'exact'} [options.edge] - 仅日期表达落在一天的哪一端。
 * @returns {{kind:'date'|'dateTime', date?:string, epochMs?:number, timeZone:string, text:string}} 解析结果。
 * @throws {TimeParseError} 无法解析时。
 */
export function parseWhen(input, options = {}) {
  const timeZone = resolveTimeZone(options.timeZone, 'Asia/Shanghai');
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const edge = options.edge ?? 'exact';
  const original = String(input ?? '');
  const raw = normalizeText(original);
  if (!raw) throw new TimeParseError(`时间参数为空。${SYNTAX_HINT}`, original);
  const text = raw.toLowerCase();

  const startOfDayEpoch = (date) => {
    if (edge === 'start') return epochFromParts({ ...parseDateParts(date), hour: 0, minute: 0, second: 0 }, timeZone);
    if (edge === 'end') return epochFromParts({ ...parseDateParts(date), hour: 23, minute: 59, second: 59 }, timeZone) + 999;
    return epochFromParts({ ...parseDateParts(date), hour: 0, minute: 0, second: 0 }, timeZone);
  };

  const asDate = (date) => ({ kind: 'date', date, timeZone, text: raw });
  const asDateTime = (epochMs) => ({ kind: 'dateTime', epochMs, timeZone, text: raw });

  // 1) 带显式偏移或 Z 的 ISO 时间（绝对时刻，不再受 timeZone 影响）。
  const absolute = /(\d{4})-(\d{2})-(\d{2})[t ](\d{1,2}):(\d{2})(?::(\d{2}))?(z|[+-]\d{2}:?\d{2})/i.exec(text);
  if (absolute) {
    const parsed = Date.parse(absolute[0].replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (Number.isFinite(parsed)) return asDateTime(parsed);
  }

  // 2) 本地日期 + 时间。
  let match = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})[日号]?(?:[t\s]+(.+))?$/.exec(text);
  if (match) {
    const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    const timePart = match[4] ?? '';
    const time = parseTimeToken(timePart);
    if (timePart && !time) {
      throw new TimeParseError(`无法识别时间部分「${match[4]}」。${SYNTAX_HINT}`, original);
    }
    if (!time) return edge === 'exact' ? asDate(toDateString(parts)) : asDateTime(startOfDayEpoch(toDateString(parts)));
    return asDateTime(epochFromParts({ ...parts, ...time, second: 0 }, timeZone));
  }

  // 3) 无年份日期：10月6日 / 10-06。
  match = /^(\d{1,2})[-/月.](\d{1,2})[日号]?(?:[t\s]+(.+))?$/.exec(text);
  if (match) {
    const today = partsInZone(now, timeZone);
    const parts = { year: today.year, month: Number(match[1]), day: Number(match[2]) };
    const time = match[3] ? parseTimeToken(match[3]) : undefined;
    if (match[3] && !time) throw new TimeParseError(`无法识别时间部分「${match[3]}」。${SYNTAX_HINT}`, original);
    if (!time) return edge === 'exact' ? asDate(toDateString(parts)) : asDateTime(startOfDayEpoch(toDateString(parts)));
    return asDateTime(epochFromParts({ ...parts, ...time, second: 0 }, timeZone));
  }

  // 4) 星期表达：下周一 / 星期五 / this friday / last monday；可后接时刻。
  match = /^(下个|下一个|下|上个|上一个|上|这个|这|本)?\s*(周|星期|礼拜)\s*([一二三四五六日天])(?:\s*(.+))?$/.exec(text);
  if (match) {
    const today = partsInZone(now, timeZone);
    const targetIndex = WEEKDAY_CHAR_INDEX[match[3]];
    let delta = (targetIndex - today.weekday + 7) % 7;
    if (/^(下个|下一个|下)$/.test(match[1] ?? '')) delta = delta === 0 ? 7 : delta + 7;
    if (/^(上个|上一个|上)$/.test(match[1] ?? '')) delta -= 7;
    const date = addDays(toDateString(today), delta);
    const remainder = (match[4] ?? '').trim();
    const time = parseTimeToken(remainder);
    if (time) return asDateTime(epochFromParts({ ...parseDateParts(date), ...time, second: 0 }, timeZone));
    const period = parsePeriodDefault(remainder);
    if (period) return { ...asDateTime(epochFromParts({ ...parseDateParts(date), ...period, second: 0 }, timeZone)), assumed: true };
    if (remainder) throw new TimeParseError(`无法识别时间部分「${remainder}」。${SYNTAX_HINT}`, original);
    return edge === 'exact' ? asDate(date) : asDateTime(startOfDayEpoch(date));
  }

  // 4b) 英文星期 + 时刻：friday 15:00 / next monday 9:00。
  match = /^(?:(next|last|this)\s+)?([a-z]{3,9})(?:\s+(.+))?$/.exec(text);
  if (match) {
    const weekday = WEEKDAY_EN.find(([pattern]) => pattern.test(match[2]));
    if (weekday) {
      const today = partsInZone(now, timeZone);
      let delta = (weekday[1] - today.weekday + 7) % 7;
      if (match[1] === 'next') delta = delta === 0 ? 7 : delta + 7;
      else if (delta === 0) delta = 7;
      if (match[1] === 'last') delta -= 7;
      const date = addDays(toDateString(today), delta);
      const time = parseTimeToken(match[3] ?? '');
      if (time) return asDateTime(epochFromParts({ ...parseDateParts(date), ...time, second: 0 }, timeZone));
      const period = parsePeriodDefault(match[3] ?? '');
      if (period) return { ...asDateTime(epochFromParts({ ...parseDateParts(date), ...period, second: 0 }, timeZone)), assumed: true };
      if (match[3]) throw new TimeParseError(`无法识别时间部分「${match[3]}」。${SYNTAX_HINT}`, original);
      return edge === 'exact' ? asDate(date) : asDateTime(startOfDayEpoch(date));
    }
  }

  // 5) 时段缩写 + 可选时刻：今晚 / 明早 / 明晚7点。
  for (const contraction of DAY_CONTRACTIONS) {
    const hit = contraction.re.exec(text);
    if (!hit) continue;
    const today = partsInZone(now, timeZone);
    const date = addDays(toDateString(today), contraction.days);
    const remainder = text.slice(hit[0].length).trim();
    // 缩写里的时段词要补回去，否则「明晚8点」会算成早上 8 点。
    const explicit = parseTimeToken(`${contraction.period} ${remainder}`.trim());
    const time = explicit ?? { hour: contraction.hour, minute: 0 };
    return {
      ...asDateTime(epochFromParts({ ...parseDateParts(date), ...time, second: 0 }, timeZone)),
      ...(explicit ? {} : { assumed: true }),
    };
  }

  // 5b) 关键词日期 + 可选时间：明天下午3点 / tomorrow 15:00 / 今天。
  for (const dayWord of DAY_WORDS) {
    const hit = dayWord.re.exec(text);
    if (!hit) continue;
    const remainder = text.slice(hit[0].length).trim();
    const today = partsInZone(now, timeZone);
    const date = addDays(toDateString(today), dayWord.days);
    const time = parseTimeToken(remainder);
    if (time) return asDateTime(epochFromParts({ ...parseDateParts(date), ...time, second: 0 }, timeZone));
    const period = parsePeriodDefault(remainder);
    if (period) return { ...asDateTime(epochFromParts({ ...parseDateParts(date), ...period, second: 0 }, timeZone)), assumed: true };
    if (remainder) throw new TimeParseError(`无法识别时间部分「${remainder}」。${SYNTAX_HINT}`, original);
    return edge === 'exact' ? asDate(date) : asDateTime(startOfDayEpoch(date));
  }

  // 6) 相对量：now / +2h / -30m / 3天后 / 2小时前。
  if (text === 'now' || text === '现在') return asDateTime(now);
  match = /^(?:now\s*)?([+-]\s*\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|分钟|分|小时|时|天|日|周|星期)$/.exec(text);
  if (match) {
    const amount = Number(match[1].replace(/\s+/g, ''));
    const unit = match[2];
    const factor = /^(m|min)/.test(unit) || unit === '分钟' || unit === '分' ? 60000
      : /^(h|hr)/.test(unit) || unit === '小时' || unit === '时' ? 3600000
        : /^(d|day)/.test(unit) || unit === '天' || unit === '日' ? 86400000
          : 604800000;
    return asDateTime(now + amount * factor);
  }
  match = /^(\d+|[零〇一二两三四五六七八九十]{1,3})\s*(分钟|分|小时|时|天|日|周|星期)\s*(后|之后|以后|前|之前|以前)$/.exec(text);
  if (match) {
    const amount = chineseNumber(match[1]);
    const forward = /后|之后|以后/.test(match[3]);
    const factor = match[2] === '分钟' ? 60000 : match[2] === '分' ? 60000
      : match[2] === '小时' || match[2] === '时' ? 3600000
        : match[2] === '天' || match[2] === '日' ? 86400000 : 604800000;
    return asDateTime(now + (forward ? 1 : -1) * amount * factor);
  }

  // 7) 纯时间：15:00 / 下午3点（按今天算）。
  const timeOnly = parseTimeToken(text);
  if (timeOnly) {
    const today = partsInZone(now, timeZone);
    const date = toDateString(today);
    return asDateTime(epochFromParts({ ...parseDateParts(date), ...timeOnly, second: 0 }, timeZone));
  }

  throw new TimeParseError(`无法解析时间「${original}」。${SYNTAX_HINT}`, original);
}

/**
 * 解析查询边界（用于 `timeMin` / `timeMax`）：只有日期时，按开始/结束时刻补齐。
 * @param {string} input - 时间表达。
 * @param {object} options - 同 {@link parseWhen}，另加 `edge`。
 * @returns {number} 毫秒时间戳。
 */
export function parseBoundary(input, options = {}) {
  const parsed = parseWhen(input, { ...options, edge: options.edge ?? 'start' });
  if (parsed.kind === 'dateTime') return parsed.epochMs;
  return parseWhen(parsed.date, { ...options, edge: options.edge ?? 'start' }).epochMs;
}

/**
 * 计算一段区间的默认范围（用于「本周」「今天」等视图）。
 * @param {string} preset - `today` / `tomorrow` / `week` / `next7days` 等。
 * @param {string} timeZone - IANA 时区。
 * @param {number} now - 当前毫秒时间戳。
 * @returns {{start:number,end:number,label:string}} 区间。
 */
export function resolveRangePreset(preset, timeZone, now = Date.now()) {
  const today = partsInZone(now, timeZone);
  const todayDate = toDateString(today);
  const startOf = (date) => epochFromParts({ ...parseDateParts(date), hour: 0, minute: 0, second: 0 }, timeZone);
  const endOf = (date) => epochFromParts({ ...parseDateParts(date), hour: 23, minute: 59, second: 59 }, timeZone) + 999;
  switch (String(preset ?? 'today').toLowerCase()) {
    case 'tomorrow':
      return { start: startOf(addDays(todayDate, 1)), end: endOf(addDays(todayDate, 1)), label: '明天' };
    case 'yesterday':
      return { start: startOf(addDays(todayDate, -1)), end: endOf(addDays(todayDate, -1)), label: '昨天' };
    case 'week':
    case 'this-week': {
      const mondayOffset = (today.weekday + 6) % 7;
      const monday = addDays(todayDate, -mondayOffset);
      return { start: startOf(monday), end: endOf(addDays(monday, 6)), label: '本周' };
    }
    case 'next-week': {
      const mondayOffset = (today.weekday + 6) % 7;
      const monday = addDays(todayDate, -mondayOffset + 7);
      return { start: startOf(monday), end: endOf(addDays(monday, 6)), label: '下周' };
    }
    case 'next7days':
    case 'week-ahead':
      return { start: startOf(todayDate), end: endOf(addDays(todayDate, 6)), label: '未来 7 天' };
    case 'today':
    default:
      return { start: startOf(todayDate), end: endOf(todayDate), label: '今天' };
  }
}
