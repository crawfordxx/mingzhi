import { HOOK_WINDOW_SEC, MIN_SHOT_SEC, ShotSchema, type Shot, type Storyboard } from './schema.js';

export interface NormalizeResult { storyboard: Storyboard; dropped: number }
const MAX_HOOKS = 3;
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** 图片可用性：photo 必须有可用图片，否则丢弃；browser 图片不可用时去掉图片 */
function checkImages(shot: Shot, images: Set<string>): Shot | null {
  const c = shot.card;
  if (c?.template === 'photo') return images.has(c.props.image) ? shot : null;
  if (c?.template === 'browser' && c.props.image !== undefined && !images.has(c.props.image)) {
    const { image: _drop, ...props } = c.props;
    return { ...shot, card: { template: 'browser', props } };
  }
  return shot;
}

/** 规则：hook 只在前 15 秒、最多 3 张；cta 只保留最后一个且必须在最后一个镜头 */
function applyPlacementRules(shots: Shot[]): Shot[] {
  let hooks = 0;
  const lastCta = shots.map((s) => s.card?.template).lastIndexOf('cta');
  return shots.map((s, i) => {
    const t = s.card?.template;
    if (t === 'hook') {
      hooks += 1;
      if (s.start >= HOOK_WINDOW_SEC || hooks > MAX_HOOKS) return { start: s.start, end: s.end, layout: 'full' };
    }
    if (t === 'cta' && (i !== lastCta || i !== shots.length - 1)) return { start: s.start, end: s.end, layout: 'full' };
    if (t === 'cta') return { ...s, layout: 'full' };
    return s;
  });
}

/** 排序、截到 [0, 片长]、消除重叠、补齐空隙（全屏人像）、短镜头并入前一个 */
function fillTimeline(shots: Shot[], durationSec: number): Shot[] {
  const sorted = [...shots].sort((a, b) => a.start - b.start);
  const out: Shot[] = [];
  let cursor = 0;
  for (const s of sorted) {
    const start = Math.max(round(Math.min(s.start, durationSec)), cursor);
    const end = round(Math.min(s.end, durationSec));
    if (end <= start) continue;
    if (start > cursor) out.push({ start: cursor, end: start, layout: 'full' });
    out.push({ ...s, start, end });
    cursor = end;
  }
  if (cursor < durationSec) out.push({ start: cursor, end: round(durationSec), layout: 'full' });
  return out.reduce<Shot[]>((acc, s) => {
    const last = acc[acc.length - 1];
    if (last && s.end - s.start < MIN_SHOT_SEC) return [...acc.slice(0, -1), { ...last, end: s.end }];
    return [...acc, s];
  }, []);
}

/** 模型分镜 → 合法、连续、覆盖 [0, 片长] 的分镜；不合法或图片不可用的镜头丢弃并计数 */
export function normalizeStoryboard(raw: unknown, durationSec: number, availableImages: string[]): NormalizeResult {
  const items = (raw as { shots?: unknown } | null)?.shots;
  if (!Array.isArray(items)) return { storyboard: { shots: [{ start: 0, end: round(durationSec), layout: 'full' }] }, dropped: 0 };
  const images = new Set(availableImages);
  const parsed = items.map((i) => ShotSchema.safeParse(i)).flatMap((p) => (p.success ? [p.data as Shot] : []));
  const checked = parsed.flatMap((s) => { const c = checkImages(s, images); return c ? [c] : []; });
  const timeline = fillTimeline(checked, durationSec);
  return { storyboard: { shots: applyPlacementRules(timeline) }, dropped: items.length - checked.length };
}
