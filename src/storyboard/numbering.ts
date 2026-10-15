/**
 * 列表卡编号统一：分镜里「1. 早上先做最难的事」「远离手机干扰」「3. 睡前规划明天」这种同一组列表编号时有时无，
 * 能确定缺的是哪几张（缺号数 = 两张编号卡之间的卡片数）就补上编号；对不上或补完超长时整组去掉编号。要么都编号，要么都不编号。
 */
import { CardSpecSchema, type CardSpec, type Shot, type TemplateId } from './schema.js';

/** 各模板里放列表项标题的字段；hook、cta、chips、compareBars 不当作列表项 */
const TITLE_FIELD: Partial<Record<TemplateId, string>> = {
  title: 'title', evidenceList: 'title', toggles: 'title', strikeList: 'title', terminal: 'title', browser: 'title', photo: 'label', bigNumber: 'label',
};
/** 序号前缀「1. 」「2、」「3）」（后面紧跟数字的不算，如「2、3 个小时」） */
const PREFIX = /^\s*(\d{1,2})\s*([.、．)）])\s*(?!\d)/;

interface Item { shot: number; field: string; body: string; n?: number; sep?: string }

function itemOf(shot: Shot, index: number): Item | null {
  const field = shot.card ? TITLE_FIELD[shot.card.template] : undefined;
  const text = field ? (shot.card?.props as Record<string, unknown>)[field] : undefined;
  if (!field || typeof text !== 'string') return null;
  const m = PREFIX.exec(text);
  return m ? { shot: index, field, body: text.slice(m[0].length), n: Number(m[1]), sep: m[2] } : { shot: index, field, body: text };
}

const label = (n: number, sep: string, body: string): string => (sep === '.' || sep === '．' ? `${n}. ${body}` : `${n}${sep}${body}`);

/** 编号卡按序号递增分组（序号回落时另起一组） */
function groupsOf(items: Item[]): number[][] {
  const numbered = items.flatMap((it, k) => (it.n === undefined ? [] : [k]));
  return numbered.reduce<number[][]>((acc, k, j) => {
    const prev = j > 0 ? items[numbered[j - 1]].n ?? 0 : Infinity;
    return (items[k].n ?? 0) > prev ? [...acc.slice(0, -1), [...acc[acc.length - 1], k]] : [...acc, [k]];
  }, []);
}

/** 一组里要补编号的卡片（新文字按镜头序号）；缺号与中间卡片数对不上时返回 null */
function fillsOf(items: Item[], group: number[]): Map<number, string> | null {
  const fills = new Map<number, string>();
  for (let j = 1; j < group.length; j++) {
    const a = items[group[j - 1]];
    const between = items.slice(group[j - 1] + 1, group[j]);
    const gap = (items[group[j]].n ?? 0) - (a.n ?? 0) - 1;
    if (gap === 0) continue;
    if (gap !== between.length) return null;
    between.forEach((it, k) => fills.set(it.shot, label((a.n ?? 0) + k + 1, a.sep ?? '.', it.body)));
  }
  return fills;
}

/** 换掉卡片的标题字段；不合模式（超长等）返回 null */
function retitle(card: CardSpec, field: string, text: string): CardSpec | null {
  const parsed = CardSpecSchema.safeParse({ template: card.template, props: { ...card.props, [field]: text } });
  return parsed.success ? parsed.data : null;
}

/** 一组的改动：能补齐就补，否则整组去掉编号 */
function editsOf(shots: Shot[], items: Item[], group: number[]): Map<number, CardSpec> {
  const byShot = new Map(items.map((it) => [it.shot, it]));
  const apply = (texts: Map<number, string>): Map<number, CardSpec> | null => {
    const out = [...texts].map(([i, text]) => [i, retitle(shots[i].card as CardSpec, (byShot.get(i) as Item).field, text)] as const);
    return out.every(([, c]) => c !== null) ? new Map(out as [number, CardSpec][]) : null;
  };
  const fills = fillsOf(items, group);
  const filled = fills && fills.size > 0 ? apply(fills) : fills && new Map<number, CardSpec>();
  if (filled) return filled;
  const strips = new Map(group.map((k) => [items[k].shot, items[k].body] as const).filter(([, body]) => body.trim().length > 0));
  return apply(strips) ?? new Map();
}

/** 统一分镜里列表卡的编号（不改动入参） */
export function unifyListNumbering(shots: Shot[]): Shot[] {
  const items = shots.flatMap((s, i) => { const it = itemOf(s, i); return it ? [it] : []; });
  const edits = groupsOf(items).filter((g) => g.length > 1).reduce((acc, g) => new Map([...acc, ...editsOf(shots, items, g)]), new Map<number, CardSpec>());
  return edits.size === 0 ? shots : shots.map((s, i) => (edits.has(i) ? { ...s, card: edits.get(i) } : s));
}
