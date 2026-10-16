import type { SfxId } from '../assets/catalog.js';

/** 音效触发点：sec 是音效文件开始播放的时刻（已扣除 anchor），整片时间轴上的秒 */
export interface SfxCue { sec: number; sfx: SfxId; volume: number }

/** 音效的「种类」：同一种类下有若干变体（音高、质感略不同），同一变体全片最多 MAX_PER_SFX 次 */
export type SfxKind = 'pop' | 'whoosh' | 'hit' | 'riser' | 'tick' | 'click' | 'toggle' | 'confirm' | 'load' | 'logo';

/** 同一音效（变体）全片最多出现的次数，超过就换同类变体，变体用尽则丢弃 */
export const MAX_PER_SFX = 6;
/** 一部正常的片子至少要有的音效种类数 */
export const MIN_KINDS = 5;

export const KIND_OF: Record<SfxId, SfxKind> = {
  enter: 'pop', exit: 'pop', sparkle: 'confirm', click: 'click', click2: 'click', toggle: 'toggle', toggle2: 'toggle', tick: 'tick', tick2: 'tick', tick3: 'tick',
  load: 'load', confirm: 'confirm', confirm2: 'confirm', confirm3: 'confirm',
  whoosh: 'whoosh', whoosh2: 'whoosh', whoosh3: 'whoosh', hit: 'hit', hit2: 'hit', hit3: 'hit', riser: 'riser', riserShort: 'riser',
  pop: 'pop', pop2: 'pop', pop3: 'pop', pop4: 'pop', logo: 'logo',
};

/** 各种类可轮换的变体（按优先顺序）；riser 由规划按距离选长短，不参与轮换 */
export const VARIANTS: Record<Exclude<SfxKind, 'riser'>, SfxId[]> = {
  pop: ['pop', 'pop2', 'pop3', 'pop4'],
  whoosh: ['whoosh', 'whoosh2', 'whoosh3'],
  hit: ['hit', 'hit2', 'hit3'],
  tick: ['tick', 'tick2', 'tick3'],
  click: ['click', 'click2'],
  toggle: ['toggle', 'toggle2'],
  confirm: ['confirm', 'confirm2', 'confirm3'],
  load: ['load'],
  logo: ['logo'],
};

/**
 * 音效文件里「与画面动作对齐」的时刻（秒）：whoosh 取响度峰值（切入的瞬间），riser 取结尾（高潮，紧接 hit），其余取起音（0）。
 * 数值由 tests/sfx-assets.test.ts 读 wav 实测核对；合成脚本 scripts/make-sfx.mjs 里有同样的清单。
 */
export const ANCHOR_SEC: Record<SfxId, number> = {
  enter: 0, exit: 0, sparkle: 0, click: 0, click2: 0, toggle: 0, toggle2: 0, tick: 0, tick2: 0, tick3: 0, load: 0, confirm: 0, confirm2: 0, confirm3: 0,
  whoosh: 0.35, whoosh2: 0.31, whoosh3: 0.52, hit: 0, hit2: 0, hit3: 0, riser: 1.2, riserShort: 0.4, pop: 0, pop2: 0, pop3: 0, pop4: 0, logo: 0,
};

export const sfxKind = (id: SfxId): SfxKind => KIND_OF[id];

export interface SfxStats {
  /** 不同种类数（变体算同一种） */
  kinds: number;
  /** 各音效（变体）出现次数 */
  perSfx: Record<string, number>;
  /** 出现最多的那个音效的次数 */
  maxRepeat: number;
}

export function sfxStats(cues: SfxCue[]): SfxStats {
  const perSfx = cues.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.sfx]: (acc[c.sfx] ?? 0) + 1 }), {});
  return {
    kinds: new Set(cues.map((c) => sfxKind(c.sfx))).size,
    perSfx,
    maxRepeat: Math.max(0, ...Object.values(perSfx)),
  };
}

/** 一个待分配的音效意图：动作发生在 at 秒；id 已指定时直接用它（riser） */
export interface SfxIntent { at: number; kind: SfxKind; volume: number; id?: SfxId }

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * 按时间顺序给每个意图选变体：同类里用得最少的优先（并列取靠前的），所以相邻的 pop、tick 会轮换音高；
 * 变体都满了（各 MAX_PER_SFX 次）、或都来不及在动作前起播（扣除 anchor 后早于 0 秒）的意图丢弃。返回按播放时刻排序的触发点
 */
export function assignVariants(intents: SfxIntent[]): SfxCue[] {
  const used = new Map<SfxId, number>();
  const count = (id: SfxId): number => used.get(id) ?? 0;
  const sorted = [...intents].sort((a, b) => a.at - b.at);
  const cues = sorted.flatMap((intent): SfxCue[] => {
    const pool = intent.id ? [intent.id] : VARIANTS[intent.kind as Exclude<SfxKind, 'riser'>];
    // 同类里用得最少的优先（并列取靠前的）；来不及提前起播的变体（anchor 太长）换下一个
    const open = pool.filter((id) => count(id) < MAX_PER_SFX && intent.at - ANCHOR_SEC[id] >= 0);
    const pick = open.reduce<SfxId | undefined>((best, id) => (best === undefined || count(id) < count(best) ? id : best), undefined);
    if (pick === undefined) return [];
    const sec = round3(intent.at - ANCHOR_SEC[pick]);
    used.set(pick, count(pick) + 1);
    return [{ sec, sfx: pick, volume: intent.volume }];
  });
  return cues.sort((a, b) => a.sec - b.sec);
}
