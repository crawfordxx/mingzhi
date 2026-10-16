/**
 * 文字里的数字提及：阿拉伯数字与中文数字等价（「两三个小时」=「2-3 小时」），带上单位类别（百分比、倍数、时长）。
 * 卡片校验用 card 模式（中文数字要跟量词或单位才算，避免把「一键」「统一」当成数字），口播原文用 source 模式（宽松，尽量都认）。
 */

/** 单位类别：'' 为普通计数（个、条、元等不区分），时长单位归一到秒/分钟/小时/天/周/月/年 */
export type NumberUnit = '' | '%' | '倍' | '秒' | '分钟' | '小时' | '天' | '周' | '月' | '年';
/** 一处数字：values 为数值（「两三」「2-3」是两个值）；vague 为「几分钟」这类概数（只看单位） */
export interface NumberMention { text: string; values: number[]; unit: NumberUnit; vague: boolean }

const TIME_UNITS: Record<string, NumberUnit> = {
  秒: '秒', 秒钟: '秒', 分钟: '分钟', 小时: '小时', 个小时: '小时', 钟头: '小时', 个钟头: '小时',
  天: '天', 周: '周', 星期: '周', 个星期: '周', 月: '月', 个月: '月', 年: '年',
};
const UNIT_RE = '%|％|倍|个?小时|个?钟头|分钟|秒钟?|天|个?星期|周|个?月|年';
/** 中文数字后面跟这些量词才算数字（card 模式） */
const MEASURE = '个|条|种|步|次|项|件|张|位|招|点|岁|元|块|人|名|句|段|遍|集|期|页|行|字|倍|成|分';
const ARABIC = new RegExp(`(\\d+(?:\\.\\d+)?)(?:\\s*([-~～—–到至、])\\s*(\\d+(?:\\.\\d+)?))?\\s*(万|亿)?\\s*(${UNIT_RE})?`, 'g');
const CHINESE = new RegExp(`(第|百分之)?([零〇一二两三四五六七八九十百千万亿点几半]+)(\\s*(?:${UNIT_RE}))?`, 'g');
const MEASURE_AFTER = new RegExp(`^(?:${MEASURE})`);
/** 列表序号前缀「1. 」「2、」（后面不是数字，「2、3 个小时」不算序号） */
const LIST_PREFIX = /^\s*\d{1,2}\s*[.、．)）]\s*(?!\d)/;

const DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const SMALL_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const BIG_UNIT: Record<string, number> = { 万: 1e4, 亿: 1e8 };

function unitOf(raw: string | undefined): NumberUnit {
  const u = (raw ?? '').trim();
  if (u === '%' || u === '％') return '%';
  if (u === '倍') return '倍';
  return TIME_UNITS[u] ?? '';
}

/** 不带「点」的中文整数：二十三、六百五十、三万五千 */
function chineseInt(s: string): number {
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of s) {
    if (ch in DIGIT) digit = DIGIT[ch];
    else if (ch in SMALL_UNIT) { section += (digit || 1) * SMALL_UNIT[ch]; digit = 0; }
    else if (ch in BIG_UNIT) { total += (section + digit) * BIG_UNIT[ch]; section = 0; digit = 0; }
  }
  return total + section + digit;
}

/** 中文数字串的数值：「两三」「三五」这类相邻两个个位数是两个值；带「点」的是小数（三点五万 = 35000） */
function chineseValues(run: string): number[] {
  if (/^[一二两三四五六七八九]{2}$/.test(run) && DIGIT[run[0]] !== DIGIT[run[1]]) return [DIGIT[run[0]], DIGIT[run[1]]];
  if (run === '半') return [0.5];
  const [int, rest = ''] = run.split('点');
  const big = /[万亿]$/.test(rest) ? BIG_UNIT[rest[rest.length - 1]] : 1;
  const frac = [...rest.replace(/[万亿]$/, '')].map((c) => DIGIT[c] ?? 0).join('');
  const base = chineseInt(int) + (frac ? Number(`0.${frac}`) : 0);
  return [rest ? base * big : base];
}

function arabicMentions(text: string): NumberMention[] {
  return [...text.matchAll(ARABIC)].map((m) => {
    const scale = m[4] ? BIG_UNIT[m[4]] : 1;
    const values = [m[1], m[3]].filter((v): v is string => v !== undefined).map((v) => Number(v) * scale);
    return { text: m[0].trim(), values, unit: unitOf(m[5]), vague: false };
  });
}

function chineseMentions(text: string, strict: boolean): NumberMention[] {
  return [...text.matchAll(CHINESE)].flatMap((m): NumberMention[] => {
    const [whole, prefix, run, unitRaw] = m;
    if (prefix === '第') return [];
    const after = text.slice((m.index ?? 0) + whole.length);
    const counted = prefix === '百分之' || unitRaw !== undefined || MEASURE_AFTER.test(after);
    if (strict && !counted) return [];
    // 「一个」「一种」「一次」是量词用法（相当于不定冠词），不算数字；「一小时」「一倍」仍算
    if (strict && run === '一' && !unitRaw && prefix !== '百分之') return [];
    const unit: NumberUnit = prefix === '百分之' ? '%' : unitOf(unitRaw);
    const measure = !unitRaw && MEASURE_AFTER.test(after) ? after[0] : '';
    const shown = `${prefix ?? ''}${run}${unitRaw ?? ''}${measure}`.trim();
    if (run.includes('几')) return [{ text: shown, values: [], unit, vague: true }];
    return [{ text: shown, values: chineseValues(run), unit, vague: false }];
  });
}

/** 文字里的数字提及；card 模式去掉开头的列表序号、中文数字须跟量词或单位 */
export function numberMentions(text: string, mode: 'card' | 'source'): NumberMention[] {
  const body = mode === 'card' ? text.replace(LIST_PREFIX, '') : text;
  return [...arabicMentions(body), ...chineseMentions(body, mode === 'card')];
}

const TIME = new Set<NumberUnit>(['秒', '分钟', '小时', '天', '周', '月', '年']);
const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** 卡片里的单位能不能用口播里的单位支撑：百分比、倍数必须一致；时长单位一致或口播没写单位；普通计数不看单位 */
function unitOk(card: NumberUnit, src: NumberUnit): boolean {
  if (card === '%' || card === '倍') return src === card;
  if (TIME.has(card)) return src === card || src === '';
  return true;
}

/** 一处卡片数字是否有口播依据；概数（几分钟）只要口播里有同样的时长单位 */
export function supported(m: NumberMention, sources: readonly NumberMention[]): boolean {
  if (m.vague) return !TIME.has(m.unit) || sources.some((s) => s.unit === m.unit);
  return m.values.every((v) => sources.some((s) => unitOk(m.unit, s.unit) && s.values.some((x) => close(x, v))));
}
