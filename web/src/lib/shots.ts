/** 镜头与时间：卡片中文名、按时间找镜头、@mm:ss 引用 */
import type { ShotState } from '../api';

const CARD_NAME: Record<string, string> = {
  hook: '钩子卡', title: '标题卡', bigNumber: '数字卡', chips: '标签卡', compareBars: '对比条卡', evidenceList: '证据清单卡',
  terminal: '终端卡', toggles: '开关卡', strikeList: '划线清单卡', browser: '网页截图', photo: '图片卡', cta: '三连CTA',
};

export interface ShotLike { layout: 'split' | 'full'; template?: string; card?: ShotState['card'] }

/** 镜头的显示名：分屏卡用模板名（钩子卡带 2/3），全屏人像叫「纯人像」；名字里不带空格，@ 引用才不会被拆开 */
export function cardName(shot: ShotLike | undefined): string {
  if (!shot) return '画面';
  const template = shot.card?.template ?? shot.template;
  if (!template) return '纯人像';
  const props = shot.card?.props;
  if (template === 'hook' && props && typeof props.index === 'number' && typeof props.total === 'number') return `钩子卡${props.index}/${props.total}`;
  return CARD_NAME[template] ?? template;
}

/** 左闭右开；越界取首尾（与 src/edit/refs.ts 的 shotForTime 一致） */
export function shotIndexAt<T extends { start: number; end: number }>(shots: readonly T[], sec: number): number {
  if (!shots.length) return -1;
  const i = shots.findIndex((s) => sec >= s.start && sec < s.end);
  if (i >= 0) return i;
  return sec < shots[0].start ? 0 : shots.length - 1;
}

/** 00:58 形式（与后端 parseTimeRefs 的 @mm:ss 一致） */
export const mmss = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export interface TimeRef { sec: number; label: string }

export const refText = (r: TimeRef): string => `@${mmss(r.sec)} ${r.label}`;

/** 发给后端的消息：每个引用后面固定跟一个空格，避免卡片名吃到后面的话 */
export const composeMessage = (refs: readonly TimeRef[], text: string): string => `${refs.map((r) => `${refText(r)} `).join('')}${text.trim()}`;

/** 把消息拆回「引用 + 正文」以便显示（引用形如 @mm:ss 名字，名字到空格为止） */
export function splitMessage(message: string): { refs: TimeRef[]; text: string } {
  const refs: TimeRef[] = [];
  let rest = message;
  for (;;) {
    const m = /^@(\d{1,2}):(\d{2})(?: ([^\s@]+))? /.exec(rest);
    if (!m) break;
    refs.push({ sec: Number(m[1]) * 60 + Number(m[2]), label: m[3] ?? '' });
    rest = rest.slice(m[0].length);
  }
  return { refs, text: rest };
}

/**
 * 引用用的整秒：@mm:ss 只有整秒精度，后端按「左闭右开」找镜头。
 * 播放头在镜头开头的零点几秒里时，向下取整会落到上一个镜头，所以夹到本镜头内的第一个整秒。
 */
export function refSecond(sec: number, shot?: { start: number; end: number }): number {
  const s = Math.floor(sec);
  if (!shot) return s;
  const first = Math.ceil(shot.start - 1e-6);
  return first < shot.end ? Math.max(s, first) : s;
}
