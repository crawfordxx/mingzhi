import { cardLead } from '../compose/card-carry.js';
import { visualLayout, visualShots } from '../compose/layout.js';
import { OUTRO_LOGO_SEC } from '../compose/ending.js';
import { HOOK_HIT_SEC } from '../../render/templates/timing.js';
import type { CardSpec, Shot } from '../storyboard/schema.js';
import { ANCHOR_SEC, assignVariants, type SfxCue, type SfxIntent, type SfxKind } from './sfx-map.js';

export { HOOK_HIT_SEC };

/** 各种音效的基准音量 */
const VOLUME = { pop: 0.2, whoosh: 0.4, whooshPip: 0.3, hit: 0.5, riser: 0.35, tick: 0.15, ui: 0.35, logo: 0.33 } as const;
/** 同一时刻（±该秒数内）只保留一个音效 */
const DEDUP_SEC = 0.05;
const EPS = 1e-9;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/*
 * 以下节奏与渲染模板保持一致（模板在 .tsx 里依赖 React，这里不引入，复制最小常量；
 * tests/audio-plan.test.ts 与模板源头对拍，改动模板时测试会报警）：
 * - 开关点击：render/templates/Toggles.tsx 的 clickTimes（按函数结果对拍）
 * - CTA 点击：render/templates/Cta.tsx 的 ctaClickTimes（按函数结果对拍）
 * - 标签弹入：render/templates/Chips.tsx 的 FIRST_POP + 序号 * STAGGER（对拍 TIMING.chips*）
 * - 数字滚动：render/templates/BigNumber.tsx 的 PURE_NUMBER 与 COUNT_START/COUNT_SEC（tick 落在窗内，滚完落 hit）
 * - 卡片内部时钟提前：compose/card-carry 的 cardLead（从人物全屏切进分屏时提前 FRESH_LEAD_SEC，内部触发点同步提前）
 * - 卡片入场：render/layers/CardLayer.tsx 的 spring 从镜头第 0 帧起，pop 对准镜头开始
 * - 钩子 hit：render/templates/timing.ts 的 HOOK_HIT_SEC（Hook.tsx 第一行高亮刷开完成的时刻，同一常量驱动动画）
 */
const EXIT_SEC = 0.25;
const TOGGLE_FIRST = 0.6;
const TOGGLE_GAP = 0.5;
const TOGGLE_SWITCH_SEC = 0.3;
const TOGGLE_DONE_BEFORE_EXIT = 0.3;
const CTA_FIRST = 0.5;
const CTA_GAP = 0.5;
const CTA_PRESS_SEC = 0.24;
const CTA_DONE_BEFORE_END = 0.2;
const CHIPS_FIRST = 0.15;
const CHIPS_STAGGER = 0.12;
const COUNT_START = 0.05;
const COUNT_SEC = 0.6;
const TICK_COUNT = 5;
const TICK_GAP = 0.1;
export const PURE_NUMBER = /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
/** 供测试与模板源头对拍的常量 */
export const TIMING = { exitSec: EXIT_SEC, chipsFirst: CHIPS_FIRST, chipsStagger: CHIPS_STAGGER } as const;

function toggleTimes(k: number, dur: number): number[] {
  const room = dur - EXIT_SEC - TOGGLE_DONE_BEFORE_EXIT - TOGGLE_SWITCH_SEC - TOGGLE_FIRST;
  const gap = k > 1 ? Math.max(0, Math.min(TOGGLE_GAP, room / (k - 1))) : 0;
  return Array.from({ length: k }, (_, j) => TOGGLE_FIRST + j * gap);
}

function ctaTimes(n: number, dur: number): number[] {
  const room = Math.max(0, dur - CTA_DONE_BEFORE_END - CTA_PRESS_SEC);
  const first = Math.min(CTA_FIRST, room);
  const gap = n > 1 ? Math.min(CTA_GAP, (room - first) / (n - 1)) : 0;
  return Array.from({ length: n }, (_, i) => first + i * gap);
}

const intent = (at: number, kind: SfxKind, volume: number): SfxIntent => ({ at, kind, volume });

/** 卡片内部动作对应的音效（at 为相对镜头开始的秒数） */
function innerIntents(card: CardSpec, dur: number): SfxIntent[] {
  switch (card.template) {
    case 'toggles': {
      const onCount = card.props.rows.filter((r) => r.on).length;
      return toggleTimes(onCount, dur).map((t) => intent(t, 'toggle', VOLUME.ui));
    }
    case 'cta':
      return ctaTimes(card.props.actions.length, dur).map((t) => intent(t, 'click', VOLUME.ui));
    case 'bigNumber': {
      if (!PURE_NUMBER.test(card.props.value)) return [];
      const ticks = Array.from({ length: TICK_COUNT }, (_, i) => intent(COUNT_START + (i + 1) * TICK_GAP, 'tick', VOLUME.tick));
      return [...ticks, intent(COUNT_START + COUNT_SEC, 'hit', VOLUME.hit)];
    }
    case 'chips': {
      const marks = card.props.groups.flatMap((g) => g.items.map((it) => it.mark));
      return marks.flatMap((m, i) => (m === 'yes' ? [intent(CHIPS_FIRST + i * CHIPS_STAGGER, 'confirm', VOLUME.ui)] : []));
    }
    case 'hook':
      return [intent(HOOK_HIT_SEC, 'hit', VOLUME.hit)];
    default:
      return [];
  }
}

/** 镜头开始处的音效：钩子由 hit 负责，不再叠入场音；browser 用 load；分屏与浮层卡片入场轻 pop；全屏镜头（cta）不入场 */
function startIntents(shot: Shot & { card: CardSpec }): SfxIntent[] {
  if (shot.card.template === 'hook') return [];
  if (shot.card.template === 'browser') return [intent(0, 'load', VOLUME.ui)];
  return shot.layout === 'split' || shot.layout === 'overlay' ? [intent(0, 'pop', VOLUME.pop)] : [];
}

/**
 * 卡片内的音效意图（整片时间轴）；晚于镜头结束的点丢弃。
 * 从人物全屏切进分屏时卡片内部时钟提前 lead 秒（cardLead）：内部动作的触发点同步提前，扣掉 lead 后早于镜头开始的（第 0 帧已就位的内容）不响；
 * 内部动作的节奏按模板实际看到的镜头时长（dur + lead）算
 */
function cardIntents(shot: Shot, lead: number): SfxIntent[] {
  if (!shot.card) return [];
  const dur = shot.end - shot.start;
  const inner = innerIntents(shot.card, dur + lead).map((c) => ({ ...c, at: c.at - lead })).filter((c) => c.at >= -EPS);
  return [...startIntents({ ...shot, card: shot.card }), ...inner]
    .filter((c) => c.at < dur)
    .map((c) => ({ ...c, at: shot.start + c.at }));
}

/** 全屏 B-roll 插入的 whoosh：峰值对准画面切入帧（全屏插入按画面时间轴，J-cut 晚 2 帧）；画中画较轻，画面随镜头开始；缺素材按全屏渲染的镜头不响 */
function brollIntents(shots: Shot[]): SfxIntent[] {
  const visual = visualShots(shots);
  return shots.flatMap((shot, i): SfxIntent[] => {
    const layout = visualLayout(shot);
    if (layout === 'broll') return [intent(visual[i].start, 'whoosh', VOLUME.whoosh)];
    return layout === 'pip' ? [intent(shot.start, 'whoosh', VOLUME.whooshPip)] : [];
  });
}

/** 按时间排序，±DEDUP_SEC 内只保留更响的一个，音量相同保留更早的 */
function dedupe(intents: SfxIntent[]): SfxIntent[] {
  const sorted = [...intents].sort((a, b) => a.at - b.at);
  return sorted.reduce<SfxIntent[]>((acc, c) => {
    const last = acc[acc.length - 1];
    if (!last || c.at - last.at > DEDUP_SEC + EPS) return [...acc, c];
    return c.volume > last.volume ? [...acc.slice(0, -1), c] : acc;
  }, []);
}

/** 第一张钩子的 riser：高潮落在它的 hit 上；够长就用长 riser，片头来不及就用短的 */
function riserIntent(shots: Shot[]): SfxIntent[] {
  const first = shots.find((s) => s.card?.template === 'hook');
  if (!first) return [];
  const at = first.start + HOOK_HIT_SEC;
  return [{ at, kind: 'riser', volume: VOLUME.riser, id: at - ANCHOR_SEC.riser >= 0 ? 'riser' : 'riserShort' }];
}

export interface SfxPlanOptions {
  /** 片尾开始的时刻（秒）；给出时在 logo 弹出处加 logo 音 */
  outroStartSec?: number;
}

/**
 * 全片音效触发点（秒，整片时间轴）：
 * 卡片入场 pop（轻）、全屏 B-roll 插入 whoosh、数字 tick + 最后一下 hit、钩子 riser + hit、片尾 logo 音，
 * 以及开关 / 点击 / 标签的原有音效。每个音效按 ANCHOR_SEC 提前起播，使「峰值 / 起音 / 高潮」落在画面动作上（偏差 ≤ 2 帧）；
 * 同一音效全片 ≤ MAX_PER_SFX 次，超过换同类变体。
 */
export function sfxCues(shots: Shot[], opts: SfxPlanOptions = {}): SfxCue[] {
  const logo = opts.outroStartSec === undefined ? [] : [intent(opts.outroStartSec + OUTRO_LOGO_SEC, 'logo', VOLUME.logo)];
  const visual = visualShots(shots);
  const all = dedupe([...shots.flatMap((shot, i) => cardIntents(shot, cardLead(visual, i))), ...brollIntents(shots), ...logo].map((c) => ({ ...c, at: round3(c.at) })));
  return assignVariants([...all, ...riserIntent(shots)]);
}
