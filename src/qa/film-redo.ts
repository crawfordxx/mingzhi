/**
 * 整片自检的局部重做（最多 1 轮）：按不达标的指标定位到镜头，只改这些镜头，不动其余镜头与时间轴（拆分只在目标镜头内部切一刀）。
 * - 首帧空 → 第一个镜头改成钩子（第一句字幕做标题，本地图形兜底）
 * - 素材复用 → 后出现的镜头去掉重复素材
 * - 铺图卡片看不清 → 浅色字压暗底图，深色字取消底图
 * - 空白过多 → 紧凑卡改浮层（人物全屏 + 浮卡）
 * - 静止过长 → 演进卡把条目铺开逐条出现；其余卡片在静止段里按字幕边界切开，后半段换版式（紧凑卡改浮层，其余回人物全屏）
 * - 模板单调 → 套用 Task 6 的分镜规则（编排后的分镜上复检修正，带素材的镜头不降级）
 * 音效重复由音效规划保证（同类变体轮换、用尽丢弃），这里不重做；摄影级画面不足需要新素材，只报告
 */
import type { TimedCaption } from '../captions/lines.js';
import { cardLead } from '../compose/card-carry.js';
import { fillReveal, fitReveal, fitRevealToShots, revealItems, REVEAL_TAIL_SEC } from '../storyboard/reveal.js';
import { applyStoryboardRules } from '../storyboard/rules.js';
import type { CardSpec, Shot, Storyboard, TemplateId } from '../storyboard/schema.js';
import { dominantShot, shotFiles, type FilmMetric, type FilmReport } from './film.js';
import { MIN_CONTRAST } from './readability.js';

export type RedoKind = 'hook' | 'dedupe' | 'dim' | 'unbacked' | 'overlay' | 'reveal' | 'split' | 'rules';
export interface RedoAction { shotIndex: number; kind: RedoKind; detail: string }
/** storyboard：重做后的分镜；actions 按原分镜的镜头序号；unfixed：定位到了但改不了的原因 */
export interface RedoPlan { storyboard: Storyboard; actions: RedoAction[]; unfixed: string[] }

/** 能改浮层的紧凑卡（与 rules.ts 的 FLOATABLE 一致：内容长的卡浮在人物身上会遮脸） */
const FLOATABLE: readonly TemplateId[] = ['title', 'bigNumber', 'chips'];
/** 拆分静止镜头：前段卡片至少留 2.5 秒（与 B-roll 切卡一致），后段至少 2 秒 */
const HEAD_MIN_SEC = 2.5;
const TAIL_MIN_SEC = 2;
/** 静止开始后这么久切开（不到 3 秒就有变化） */
const BREAK_AFTER_SEC = 2;
/** 首帧兜底的钩子最长这么久，镜头更长时在字幕边界切开、后段保持原样 */
const HOOK_MAX_SEC = 4;
const HOOK_TEXT_MAX = 60;
/** 压暗后按白字算的目标对比度（留出半透明白字、抗锯齿的余量） */
const DIM_TARGET = 5.5;
const DIM_MIN = 0.3;
const DIM_MAX = 0.8;
const SRGB_GAMMA = 2.2;

/**
 * 浅色字压暗底图的强度（叠加黑色的不透明度）：按量到的对比度反推底色亮度（按白字算），压到目标对比度需要的亮度；
 * 已有压暗时叠加；夹在 0.3–0.8
 */
export function dimFor(contrast: number, current = 0): number {
  const bg = Math.max(0.01, 1.05 / Math.max(1, contrast) - 0.05);
  const target = 1.05 / DIM_TARGET - 0.05;
  const need = bg <= target ? DIM_MIN : 1 - (target / bg) ** (1 / SRGB_GAMMA);
  const total = 1 - (1 - current) * (1 - Math.max(DIM_MIN, need));
  return Math.round(Math.min(DIM_MAX, total) * 100) / 100;
}
const FPS = 30;

interface Split { index: number; at: number; head: Shot; tail: Shot }
interface Work { shots: Shot[]; actions: RedoAction[]; unfixed: string[]; splits: Split[]; claimed: Set<number> }

/** 进度与报告里的中文名（与工作台 web/src/lib/shots.ts 的卡片名一致） */
const CARD_NAME: Record<TemplateId, string> = {
  hook: '钩子卡', title: '标题卡', bigNumber: '数字卡', chips: '标签卡', compareBars: '对比条卡', evidenceList: '证据清单卡', terminal: '终端卡',
  toggles: '开关卡', strikeList: '划线清单卡', browser: '网页截图', photo: '图片卡', cta: 'CTA', flow: '流程卡',
};
const LAYOUT_NAME: Record<Shot['layout'], string> = { split: '分屏', full: '人物全屏', broll: '全屏素材', pip: '画中画', overlay: '浮层' };
const nameOf = (s: Shot): string => (s.card ? CARD_NAME[s.card.template] : LAYOUT_NAME[s.layout]);

const failing = (r: FilmReport, id: FilmMetric['id']): FilmMetric | undefined => r.metrics.find((m) => m.id === id && !m.ok);
const nth = (i: number): string => `第 ${i + 1} 镜`;
const snap = (t: number): number => Math.round(t * FPS) / FPS;

function edit(w: Work, i: number, shot: Shot, kind: RedoKind, detail: string): Work {
  return { ...w, shots: w.shots.map((s, k) => (k === i ? shot : s)), actions: [...w.actions, { shotIndex: i, kind, detail }], claimed: new Set([...w.claimed, i]) };
}
const note = (w: Work, text: string): Work => ({ ...w, unfixed: [...w.unfixed, text] });
const split = (w: Work, sp: Split, detail: string): Work =>
  ({ ...w, splits: [...w.splits, sp], actions: [...w.actions, { shotIndex: sp.index, kind: 'split', detail }], claimed: new Set([...w.claimed, sp.index]) });

/** 镜头内（不含两端）的字幕起点里离 target 最近的一个，限定在 [lo, hi]；没有就用 target 对齐到帧 */
function cutPoint(captions: TimedCaption[], lo: number, hi: number, target: number): number {
  const inside = captions.map((c) => c.start).filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9);
  const best = inside.reduce<number | undefined>((b, t) => (b === undefined || Math.abs(t - target) < Math.abs(b - target) ? t : b), undefined);
  return best ?? snap(Math.min(hi, Math.max(lo, target)));
}

// ---------- 首帧 ----------

/** 第一个镜头改成钩子：标题取镜头里第一句字幕；已有的钩子顺延编号（最多 3 张） */
function hookFirst(w: Work, captions: TimedCaption[]): Work {
  const s = w.shots[0];
  if (!s) return w;
  if (s.card?.template === 'hook') return note(w, '首帧空：第 1 镜已是钩子，未改');
  const hooks = w.shots.filter((x) => x.card?.template === 'hook').length;
  const text = (captions.find((c) => c.end > s.start && c.start < s.end) ?? captions[0])?.text.trim().slice(0, HOOK_TEXT_MAX);
  if (!text || hooks >= 3) return note(w, `首帧空：${!text ? '没有字幕可做钩子标题' : '钩子已有 3 张'}，未改`);
  const total = hooks + 1;
  const renumbered = w.shots.map((x) => (x.card?.template === 'hook' ? { ...x, card: { ...x.card, props: { ...x.card.props, index: x.card.props.index + 1, total } } } : x));
  const card: CardSpec = { template: 'hook', props: { index: 1, total, headline: text, highlight: [] } };
  const base = { ...w, shots: renumbered };
  if (s.end - s.start <= HOOK_MAX_SEC + 1e-9) return edit(base, 0, { start: s.start, end: s.end, layout: 'split', card }, 'hook', `第一句字幕做钩子：${text}`);
  const at = cutPoint(captions, s.start + 1.5, s.start + HOOK_MAX_SEC, s.start + 3);
  return split(base, { index: 0, at, head: { start: s.start, end: at, layout: 'split', card }, tail: { ...s, start: at } }, `前 ${(at - s.start).toFixed(1)} 秒改成钩子：${text}`);
}

// ---------- 素材复用 ----------

/** 去掉镜头里的这些素材：全屏插入、画中画、只有素材的分屏或浮层回到人物全屏；钩子退回本地图形；图片卡、截图卡回到人物全屏 */
function dropMedia(s: Shot, files: string[]): Shot {
  const t = files.includes(s.broll?.file ?? '') ? withoutBroll(s) : s;
  const p = (t.card?.props ?? {}) as { image?: string; video?: string };
  const hit = [p.image, p.video].some((f) => f !== undefined && files.includes(f));
  if (!hit || !t.card) return t;
  if (t.card.template === 'hook') {
    const { image: _i, video: _v, mediaLabel: _l, ...props } = t.card.props;
    return { ...t, card: { ...t.card, props } };
  }
  return t.broll ? { start: t.start, end: t.end, layout: 'split', broll: t.broll } : { start: t.start, end: t.end, layout: 'full' };
}

function withoutBroll(s: Shot): Shot {
  const { broll: _b, ...rest } = s;
  return rest.card && (rest.layout === 'split' || rest.layout === 'overlay') ? rest : { start: s.start, end: s.end, layout: 'full', ...(rest.card?.template === 'cta' ? { card: rest.card } : {}) };
}

function dedupe(w: Work, m: FilmMetric): Work {
  return m.shots.reduce((acc, i) => {
    const s = acc.shots[i];
    if (!s || acc.claimed.has(i)) return acc;
    const before = new Set(acc.shots.slice(0, i).flatMap(shotFiles));
    const dup = shotFiles(s).filter((f) => before.has(f));
    // 文件不同但来自同一个候选（同一张图的不同裁切）：去掉镜头 B-roll
    const files = dup.length > 0 ? dup : s.broll ? [s.broll.file] : shotFiles(s);
    return edit(acc, i, dropMedia(s, files), 'dedupe', `去掉重复素材 ${files.join('、')}`);
  }, w);
}

// ---------- 可读性 ----------

function readable(w: Work, r: FilmReport): Work {
  const bad = (r.contrasts ?? []).filter((c) => c.contrast < MIN_CONTRAST);
  return bad.reduce((acc, c) => {
    const s = acc.shots[c.shotIndex];
    if (!s?.broll || acc.claimed.has(c.shotIndex)) return acc;
    if (c.polarity === 'light') {
      const dim = dimFor(c.contrast, s.broll.dim ?? 0);
      return edit(acc, c.shotIndex, { ...s, broll: { ...s.broll, dim } }, 'dim', `文字对比度 ${c.contrast.toFixed(1)}，底图压暗 ${Math.round(dim * 100)}%`);
    }
    const { broll: _b, ...rest } = s;
    return edit(acc, c.shotIndex, rest, 'unbacked', `文字对比度 ${c.contrast.toFixed(1)}（深色字），取消底图`);
  }, w);
}

// ---------- 空白 ----------

const floatable = (s: Shot): boolean => s.layout === 'split' && !s.broll && FLOATABLE.includes(s.card?.template as TemplateId);

function fillBlank(w: Work, m: FilmMetric): Work {
  return m.shots.reduce((acc, i) => {
    const s = acc.shots[i];
    if (!s || acc.claimed.has(i)) return acc;
    if (floatable(s)) return edit(acc, i, { ...s, layout: 'overlay' }, 'overlay', `${nameOf(s)}改浮层（人物全屏 + 浮卡）`);
    return note(acc, `空白：${nth(i)}（${nameOf(s)}）没有可铺的素材，未改`);
  }, w);
}

// ---------- 静止 ----------

/** 演进卡的条目铺开：没有 reveal 时先按字幕补，补不了或已有 reveal 时在镜头里均匀铺开；和原来一样就返回 undefined */
function spreadReveal(s: Shot, captions: TimedCaption[]): Shot | undefined {
  const card = s.card;
  if (!card) return undefined;
  const has = (card.props as { reveal?: number[] }).reveal;
  const byCaption = has ? undefined : fillReveal([s], captions)[0];
  if (byCaption && byCaption !== s) return byCaption;
  const n = revealItems(card);
  const hi = Math.max(0, s.end - s.start - REVEAL_TAIL_SEC);
  const reveal = fitReveal(Array.from({ length: n }, (_, i) => (n > 1 ? (i * hi) / (n - 1) : 0)), n, s.end - s.start);
  if (!reveal || (has && reveal.every((t, i) => Math.abs(t - has[i]) < 0.05))) return undefined;
  return { ...s, card: { ...card, props: { ...card.props, reveal } } as CardSpec };
}

/** 静止的卡片镜头在静止段里切开，后段换版式 */
function breakStill(w: Work, i: number, from: number, captions: TimedCaption[]): Work {
  const s = w.shots[i];
  const tpl = s.card?.template;
  if (s.layout !== 'split' || !s.card || tpl === 'hook' || tpl === 'cta' || s.end - s.start < HEAD_MIN_SEC + TAIL_MIN_SEC) return note(w, `静止：${nth(i)}（${nameOf(s)}）不便拆分，未改`);
  const at = cutPoint(captions, s.start + HEAD_MIN_SEC, s.end - TAIL_MIN_SEC, Math.max(s.start + HEAD_MIN_SEC, from + BREAK_AFTER_SEC));
  const [head] = fitRevealToShots([{ ...s, end: at }]);
  const { broll: _b, ...rest } = s;
  // 后段延续前段的卡片：内部时钟接着走（计数、弹入不重放），只做一次浮层入场
  const lead = Math.round((at - s.start + cardLead(w.shots, i)) * 1000) / 1000;
  const tail: Shot = FLOATABLE.includes(tpl as TemplateId) ? { ...rest, start: at, layout: 'overlay', lead } : { start: at, end: s.end, layout: 'full' };
  return split(w, { index: i, at, head, tail }, `${nameOf(s)}在 ${at.toFixed(1)} 秒切开，后段${tail.layout === 'overlay' ? '改浮层' : '回人物全屏'}`);
}

function unfreeze(w: Work, m: FilmMetric, captions: TimedCaption[]): Work {
  return (m.spans ?? []).reduce((acc, span) => {
    const i = dominantShot(acc.shots, span);
    const s = acc.shots[i];
    if (!s || acc.claimed.has(i)) return acc;
    const spread = s.card && revealItems(s.card) > 0 ? spreadReveal(s, captions) : undefined;
    if (spread) return edit(acc, i, spread, 'reveal', `${nameOf(s)}条目按口播铺开逐条出现`);
    return s.card ? breakStill(acc, i, span.start, captions) : note(acc, `静止：${nth(i)}（${nameOf(s)}）没有卡片可演进，未改`);
  }, w);
}

// ---------- 多样性 ----------

function diversify(w: Work, durationSec: number): Work {
  const r = applyStoryboardRules(w.shots, durationSec);
  const changed = r.shots.flatMap((s, i) => (JSON.stringify(s) !== JSON.stringify(w.shots[i]) && !w.claimed.has(i) ? [i] : []));
  if (changed.length === 0) return r.fixes.length > 0 ? note(w, `模板多样性：${r.fixes.join('；')}（规则修不了）`) : w;
  return changed.reduce((acc, i) => edit(acc, i, r.shots[i], 'rules', r.fixes.join('；')), w);
}

/** 拆分从后往前做，前面的序号不受影响 */
const applySplits = (shots: Shot[], splits: Split[]): Shot[] =>
  [...splits].sort((a, b) => b.index - a.index).reduce((acc, sp) => [...acc.slice(0, sp.index), sp.head, sp.tail, ...acc.slice(sp.index + 1)], shots);

/** 按不达标的指标出一轮局部重做；全部达标时原样返回 */
export function planRedo(storyboard: Storyboard, report: FilmReport, captions: TimedCaption[], durationSec: number): RedoPlan {
  let w: Work = { shots: storyboard.shots, actions: [], unfixed: [], splits: [], claimed: new Set() };
  if (failing(report, 'firstFrame')) w = hookFirst(w, captions);
  const reuse = failing(report, 'reuse');
  if (reuse) w = dedupe(w, reuse);
  if (failing(report, 'readability')) w = readable(w, report);
  const blank = failing(report, 'blank');
  if (blank) w = fillBlank(w, blank);
  const still = failing(report, 'static');
  if (still) w = unfreeze(w, still, captions);
  if (failing(report, 'diversity')) w = diversify(w, durationSec);
  if (failing(report, 'coverage')) w = note(w, '摄影级画面不足：需要更多素材（填写 Pexels 或 Pixabay key、放宽素材预算），局部重做不新增素材');
  const shots = applySplits(w.shots, w.splits);
  return { storyboard: w.actions.length > 0 ? { ...storyboard, shots } : storyboard, actions: w.actions, unfixed: w.unfixed };
}

/** project.json 的 film 字段：首次度量、局部重做做了什么（与改不了的原因）、重做后的复测（没重做时缺省） */
export interface FilmQa { before: FilmReport; actions: RedoAction[]; unfixed: string[]; after?: FilmReport }
