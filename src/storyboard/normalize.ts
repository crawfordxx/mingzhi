import type { Mood } from '../assets/catalog.js';
import { unifyListNumbering } from './numbering.js';
import { CANVAS, CoverTitleSchema, DEFAULT_MOOD, HOOK_WINDOW_SEC, MAX_SHOT_SEC, MIN_SHOT_SEC, MOODS, ShotSchema, type CardSpec, type CoverTitle, type Shot, type Storyboard } from './schema.js';

export interface NormalizeResult {
  storyboard: Storyboard;
  /** 不可用的镜头：结构不合法、photo 既无可用素材也无 visual，或被裁切后整体覆盖/超出片长而跳过 */
  dropped: number;
  /** 因版式规则（hook 超窗或超量、cta 非末尾）或短镜头并入相邻镜头而失去卡片的镜头 */
  demoted: number;
  /** 因超过 MAX_SHOT_SEC 被截短的带卡片镜头数 */
  capped: number;
}

const MAX_HOOKS = 3;
/** 短镜头前后都并不进去时，前一张卡片允许超出 MAX_SHOT_SEC 不足 1 秒（软上限），避免留下不足 1 秒的全屏闪屏 */
const SOFT_MAX_SHOT_SEC = MAX_SHOT_SEC + MIN_SHOT_SEC;
/** 末尾 cta 至少这么长，三连点击才放得下 */
const CTA_MIN_SEC = 2;
const round = (n: number): number => Math.round(n * 1000) / 1000;
const countCards = (shots: Shot[]): number => shots.filter((s) => s.card !== undefined).length;
const plain = (s: Shot): Shot => ({ start: s.start, end: s.end, layout: 'full' });

function omitKey<P extends object, K extends keyof P>(obj: P, key: K): Omit<P, K> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key)) as Omit<P, K>;
}

const fileOk = (file: string | undefined, files: Set<string>): boolean => file === undefined || files.has(file);
/** 去掉不在可用列表里的 image / video */
const stripUnavailable = <P extends { image?: string; video?: string }>(props: P, files: Set<string>): P => (
  Object.fromEntries(Object.entries(props).filter(([k, v]) => (k !== 'image' && k !== 'video') || files.has(v as string))) as P
);

/** photo：image/video 有可用的 → 保留；否则有 visual（等待素材）→ 去掉不可用的文件后保留；否则丢弃 */
function sanitizePhoto(card: Extract<CardSpec, { template: 'photo' }>, files: Set<string>): CardSpec | null {
  const { image, video, visual } = card.props;
  const usable = (image !== undefined && files.has(image)) || (video !== undefined && files.has(video));
  if (!usable && !visual) return null;
  const props = stripUnavailable(card.props, files);
  // 已有可用素材时不再按 visual 另取，避免重复生成或覆盖模型选定的文件
  return { template: 'photo', props: usable ? omitKey(props, 'visual') : props };
}

/** 卡片字段清理：图片/视频不可用则去掉（photo 见 sanitizePhoto，什么都没有则丢弃镜头）；去掉无效的高亮项 */
function sanitizeCard(card: CardSpec, files: Set<string>): CardSpec | null {
  switch (card.template) {
    case 'photo':
      return sanitizePhoto(card, files);
    case 'browser':
      return { template: 'browser', props: fileOk(card.props.image, files) ? card.props : omitKey(card.props, 'image') };
    case 'hook': {
      const { headline, highlight } = card.props;
      return { template: 'hook', props: stripUnavailable({ ...card.props, highlight: highlight.filter((h) => headline.includes(h)) }, files) };
    }
    case 'evidenceList': {
      const { highlight, rows } = card.props;
      return highlight === undefined ? card : { template: 'evidenceList', props: { ...card.props, highlight: highlight.filter((i) => i < rows.length) } };
    }
    default:
      return card;
  }
}

/** 无卡片的 split 镜头变为全屏；full 镜头只有 cta 能显示卡片，带其他卡片的改为 split（保留内容，否则会为看不见的卡片白取素材）；卡片不可用则返回 null（镜头整体丢弃） */
function sanitizeShot(shot: Shot, files: Set<string>): Shot | null {
  if (!shot.card) return { ...shot, layout: 'full' };
  const card = sanitizeCard(shot.card, files);
  if (!card) return null;
  return { ...shot, card, layout: shot.layout === 'full' && card.template !== 'cta' ? 'split' : shot.layout };
}

/** 裁进 [0, D] 并消除重叠；裁后为空的镜头计入 dropped */
function clampAndResolve(shots: Shot[], durationSec: number): { placed: Shot[]; dropped: number } {
  const sorted = [...shots].sort((a, b) => a.start - b.start);
  const placed: Shot[] = [];
  let dropped = 0;
  let cursor = 0;
  for (const s of sorted) {
    const start = Math.max(round(Math.min(s.start, durationSec)), cursor);
    const end = round(Math.min(s.end, durationSec));
    if (end <= start) {
      dropped += 1;
      continue;
    }
    placed.push({ ...s, start, end });
    cursor = end;
  }
  return { placed, dropped };
}

/** 最后一个 cta 若是结束最晚的卡片镜头，则延伸到片尾并吸收其后的无卡片镜头，保证 cta 不被补齐或合并吞掉、时间轴不重叠 */
function extendCta(shots: Shot[], durationSec: number): Shot[] {
  const ctaIdx = shots.map((s) => s.card?.template).lastIndexOf('cta');
  if (ctaIdx < 0) return shots;
  const cardEnd = Math.max(...shots.filter((s) => s.card).map((s) => s.end));
  if (shots[ctaIdx].end < cardEnd) return shots;
  // cta 之后的镜头必然没有卡片（否则 cta 不是结束最晚的卡片镜头），整段并入 cta
  return [...shots.slice(0, ctaIdx), { ...shots[ctaIdx], end: round(durationSec) }];
}

/** 带卡片的镜头限长 MAX_SHOT_SEC：普通镜头留开头，末尾的 cta 留结尾；余下由 fillGaps 补为全屏。余下不足 MIN_SHOT_SEC 时少留一点，避免被 mergeShort 并回 */
function capLongShots(shots: Shot[]): { shots: Shot[]; capped: number } {
  const out = shots.map((s, i): Shot => {
    const len = round(s.end - s.start);
    if (!s.card || len <= MAX_SHOT_SEC) return s;
    const keep = len - MAX_SHOT_SEC < MIN_SHOT_SEC ? Math.min(MAX_SHOT_SEC, len - MIN_SHOT_SEC) : MAX_SHOT_SEC;
    const tail = s.card.template === 'cta' && i === shots.length - 1;
    return tail ? { ...s, start: round(s.end - keep) } : { ...s, end: round(s.start + keep) };
  });
  return { shots: out, capped: out.filter((s, i) => s !== shots[i]).length };
}

/** 补齐空隙为全屏镜头，并补到片长 */
function fillGaps(shots: Shot[], durationSec: number): Shot[] {
  const out: Shot[] = [];
  let cursor = 0;
  for (const s of shots) {
    if (s.start > cursor) out.push({ start: cursor, end: s.start, layout: 'full' });
    out.push(s);
    cursor = s.end;
  }
  if (cursor < durationSec) out.push({ start: cursor, end: round(durationSec), layout: 'full' });
  return out;
}

/** 短镜头的去向：keep 原样保留、prev 并入前一个、next 并入后一个、plain 改为全屏（实在放不下时） */
type Fate = 'keep' | 'prev' | 'next' | 'plain';

/** 短于 MIN_SHOT_SEC 的镜头（末尾 cta 除外；非末尾的 cta 之后会被降级，照常合并）：先并入前一个（带卡片的不超过 MAX_SHOT_SEC），再试并入后一个（同样限长），都不行时前一个按软上限并入，最后才改为全屏；首个镜头只能并入后一个，放不下就保留 */
function shortFate(last: Shot | undefined, s: Shot, next: Shot | undefined): Fate {
  if (round(s.end - s.start) >= MIN_SHOT_SEC || (s.card?.template === 'cta' && !next)) return 'keep';
  const fitsNext = next !== undefined && (!next.card || round(next.end - s.start) <= MAX_SHOT_SEC);
  if (!last) return fitsNext ? 'next' : 'keep';
  if (!last.card || round(s.end - last.start) <= MAX_SHOT_SEC) return 'prev';
  if (fitsNext) return 'next';
  return round(s.end - last.start) < SOFT_MAX_SHOT_SEC ? 'prev' : 'plain';
}

/** 合并短镜头；并入后一个时不输出本镜头，后一个从已排好的末尾开始（起点提前） */
function mergeShort(shots: Shot[]): Shot[] {
  return shots.reduce<Shot[]>((acc, shot, i) => {
    const last = acc[acc.length - 1];
    const from = last ? last.end : 0;
    const s = shot.start > from ? { ...shot, start: from } : shot;
    const fate = shortFate(last, s, shots[i + 1]);
    if (fate === 'prev') return [...acc.slice(0, -1), { ...last, end: s.end }];
    if (fate === 'next') return acc;
    return [...acc, fate === 'plain' ? plain(s) : s];
  }, []);
}

/** 相邻的无卡片全屏镜头合并成一个 */
function mergePlain(shots: Shot[]): Shot[] {
  return shots.reduce<Shot[]>((acc, s) => {
    const last = acc[acc.length - 1];
    return last && !last.card && !s.card ? [...acc.slice(0, -1), { ...last, end: s.end }] : [...acc, s];
  }, []);
}

/** 末尾 cta 不足 CTA_MIN_SEC 时起点前移，从前一个镜头借时长（前一个至少留 MIN_SHOT_SEC）；前一个没有卡片且借完会太短时整个并入 cta */
function ensureCtaRoom(shots: Shot[]): Shot[] {
  const last = shots[shots.length - 1];
  const prev = shots[shots.length - 2];
  if (!prev || last.card?.template !== 'cta' || round(last.end - last.start) >= CTA_MIN_SEC) return shots;
  // 向下取整到帧，帧对齐后仍不短于 CTA_MIN_SEC
  const wanted = Math.floor(round(last.end - CTA_MIN_SEC) * CANVAS.fps) / CANVAS.fps;
  // 前一个是空镜头且借完不足 1 秒：整个并入 cta，再继续向更早的镜头借（镜头数递减，必然终止）
  if (!prev.card && wanted - prev.start < MIN_SHOT_SEC) return ensureCtaRoom([...shots.slice(0, -2), { ...last, start: prev.start }]);
  const start = Math.max(wanted, round(prev.start + MIN_SHOT_SEC));
  return start >= last.start ? shots : [...shots.slice(0, -2), { ...prev, end: start }, { ...last, start }];
}

const snap = (sec: number): number => Math.round(sec * CANVAS.fps) / CANVAS.fps;

/** 内部边界对齐到帧（1/30 秒），片头 0、片尾保持片长；对齐后为零长的镜头去掉（前后仍首尾相接） */
function snapToFrames(shots: Shot[], durationSec: number): Shot[] {
  const end = round(durationSec);
  const at = (sec: number, i: number): number => (i === 0 ? 0 : i === shots.length ? end : Math.min(snap(sec), end));
  return shots.map((s, i): Shot => ({ ...s, start: at(s.start, i), end: at(s.end, i + 1) })).filter((s) => s.end > s.start);
}

/** 版式规则：hook 只取窗口内前 3 个并按序重编号；cta 只保留位于末尾的那个 */
function applyPlacementRules(shots: Shot[]): Shot[] {
  const hookIdx = shots.flatMap((s, i) => (s.card?.template === 'hook' && s.start < HOOK_WINDOW_SEC ? [i] : [])).slice(0, MAX_HOOKS);
  const hookNo = new Map(hookIdx.map((i, n) => [i, n + 1] as const));
  return shots.map((s, i): Shot => {
    const card = s.card;
    if (!card) return s;
    if (card.template === 'hook') {
      const no = hookNo.get(i);
      return no === undefined ? plain(s) : { ...s, card: { template: 'hook', props: { ...card.props, index: no, total: hookIdx.length } } };
    }
    if (card.template === 'cta') {
      return i === shots.length - 1 ? { ...s, layout: 'full' } : plain(s);
    }
    return s;
  });
}

/** 背景乐情绪：不在枚举内一律按缺省 */
function readMood(raw: unknown): Mood {
  const mood = (raw as { bgm?: unknown } | null)?.bgm;
  return MOODS.find((m) => m === mood) ?? DEFAULT_MOOD;
}

/** 封面标题：主标题不合格就整体不要（交给兜底）；小标题不合格只丢小标题 */
function readCoverTitle(raw: unknown): CoverTitle | undefined {
  const c = (raw as { coverTitle?: unknown } | null)?.coverTitle;
  const whole = CoverTitleSchema.safeParse(c);
  if (whole.success) return whole.data;
  const main = CoverTitleSchema.pick({ title: true }).safeParse(c);
  return main.success ? main.data : undefined;
}

/** 分镜里与镜头无关的附加字段（背景乐情绪、封面标题） */
function readExtras(raw: unknown): Pick<Storyboard, 'bgm' | 'coverTitle'> {
  const coverTitle = readCoverTitle(raw);
  return { bgm: readMood(raw), ...(coverTitle ? { coverTitle } : {}) };
}

/** 模型分镜 → 合法、连续、覆盖 [0, 片长] 的分镜；同一组列表卡的编号统一（要么都编号要么都不编号） */
export function normalizeStoryboard(raw: unknown, durationSec: number, availableImages: string[]): NormalizeResult {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error(`分镜归一化失败：片长无效（${durationSec}）`);
  const items = (raw as { shots?: unknown } | null)?.shots;
  const extras = readExtras(raw);
  if (!Array.isArray(items)) return { storyboard: { shots: [{ start: 0, end: round(durationSec), layout: 'full' }], ...extras }, dropped: 0, demoted: 0, capped: 0 };

  const images = new Set(availableImages);
  const valid = items.flatMap((i) => { const p = ShotSchema.safeParse(i); return p.success ? [p.data as Shot] : []; });
  const usable = valid.flatMap((s) => { const c = sanitizeShot(s, images); return c ? [c] : []; });
  const { placed, dropped: overlapDropped } = clampAndResolve(usable, durationSec);
  const { shots: capped, capped: cappedCount } = capLongShots(extendCta(placed, durationSec));
  const merged = mergePlain(applyPlacementRules(mergeShort(fillGaps(capped, durationSec))));
  const shots = unifyListNumbering(snapToFrames(ensureCtaRoom(merged), durationSec));

  return {
    storyboard: { shots, ...extras },
    dropped: items.length - usable.length + overlapDropped,
    demoted: countCards(placed) - countCards(shots),
    capped: cappedCount,
  };
}
