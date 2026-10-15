import { HOOK_WINDOW_SEC, MAX_SHOT_SEC, MIN_SHOT_SEC, ShotSchema, type CardSpec, type Shot, type Storyboard } from './schema.js';

export interface NormalizeResult {
  storyboard: Storyboard;
  /** 不可用的镜头：结构不合法、photo 缺图，或被裁切后整体覆盖/超出片长而跳过 */
  dropped: number;
  /** 因版式规则（hook 超窗或超量、cta 非末尾）或短镜头并入前一个而失去卡片的镜头 */
  demoted: number;
  /** 因超过 MAX_SHOT_SEC 被截短的带卡片镜头数 */
  capped: number;
}

const MAX_HOOKS = 3;
const round = (n: number): number => Math.round(n * 1000) / 1000;
const countCards = (shots: Shot[]): number => shots.filter((s) => s.card !== undefined).length;
const plain = (s: Shot): Shot => ({ start: s.start, end: s.end, layout: 'full' });

function omitKey<P extends object, K extends keyof P>(obj: P, key: K): Omit<P, K> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key)) as Omit<P, K>;
}

const imageOk = (image: string | undefined, images: Set<string>): boolean => image === undefined || images.has(image);

/** 卡片字段清理：图片不可用则去掉（photo 除外，由调用方丢弃镜头）；去掉无效的高亮项 */
function sanitizeCard(card: CardSpec, images: Set<string>): CardSpec | null {
  switch (card.template) {
    case 'photo':
      return images.has(card.props.image) ? card : null;
    case 'browser':
      return { template: 'browser', props: imageOk(card.props.image, images) ? card.props : omitKey(card.props, 'image') };
    case 'hook': {
      const { headline, highlight, image } = card.props;
      const kept = { ...card.props, highlight: highlight.filter((h) => headline.includes(h)) };
      return { template: 'hook', props: imageOk(image, images) ? kept : omitKey(kept, 'image') };
    }
    case 'evidenceList': {
      const { highlight, rows } = card.props;
      return highlight === undefined ? card : { template: 'evidenceList', props: { ...card.props, highlight: highlight.filter((i) => i < rows.length) } };
    }
    default:
      return card;
  }
}

/** 无卡片的 split 镜头变为全屏；卡片不可用则返回 null（镜头整体丢弃） */
function sanitizeShot(shot: Shot, images: Set<string>): Shot | null {
  if (!shot.card) return { ...shot, layout: 'full' };
  const card = sanitizeCard(shot.card, images);
  return card ? { ...shot, card } : null;
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

/** 短于 MIN_SHOT_SEC 的镜头并入前一个（cta 与首个镜头除外） */
function mergeShort(shots: Shot[]): Shot[] {
  return shots.reduce<Shot[]>((acc, s) => {
    const last = acc[acc.length - 1];
    const isShort = round(s.end - s.start) < MIN_SHOT_SEC;
    if (!last || !isShort || s.card?.template === 'cta') return [...acc, s];
    // 并入后带卡片的镜头会超过 MAX_SHOT_SEC：不合并，短镜头改为全屏人像
    if (last.card && round(s.end - last.start) > MAX_SHOT_SEC) return [...acc, plain(s)];
    return [...acc.slice(0, -1), { ...last, end: s.end }];
  }, []);
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

/** 模型分镜 → 合法、连续、覆盖 [0, 片长] 的分镜 */
export function normalizeStoryboard(raw: unknown, durationSec: number, availableImages: string[]): NormalizeResult {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error(`分镜归一化失败：片长无效（${durationSec}）`);
  const items = (raw as { shots?: unknown } | null)?.shots;
  if (!Array.isArray(items)) return { storyboard: { shots: [{ start: 0, end: round(durationSec), layout: 'full' }] }, dropped: 0, demoted: 0, capped: 0 };

  const images = new Set(availableImages);
  const valid = items.flatMap((i) => { const p = ShotSchema.safeParse(i); return p.success ? [p.data as Shot] : []; });
  const usable = valid.flatMap((s) => { const c = sanitizeShot(s, images); return c ? [c] : []; });
  const { placed, dropped: overlapDropped } = clampAndResolve(usable, durationSec);
  const { shots: capped, capped: cappedCount } = capLongShots(extendCta(placed, durationSec));
  const shots = applyPlacementRules(mergeShort(fillGaps(capped, durationSec)));

  return {
    storyboard: { shots },
    dropped: items.length - usable.length + overlapDropped,
    demoted: countCards(placed) - countCards(shots),
    capped: cappedCount,
  };
}
