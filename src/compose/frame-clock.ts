import { CANVAS, type Shot } from '../storyboard/schema.js';

/**
 * 一帧里各画面层实际取用的时刻（Talk.tsx 渲染与分段哈希共用，保证指纹按「画面真正画了什么」算）：
 * - visualSec：卡片层的时刻；镜头末帧之后（留白、片尾）定格在镜头末帧
 * - personSec：人像、两层全屏素材、颗粒人物区域的时刻；口播内容末帧之后（CTA 超出内容结尾、留白、片尾）定格在内容末帧，
 *   此时画面里的人像与素材来自内容末帧所在的镜头（常是 CTA 前一个镜头）
 * shots 用原始镜头（不是 visualShots）：末镜头结尾与 Talk 同口径
 */
export interface FrameClock {
  sec: number; visualSec: number; personSec: number;
  shotFrames: number; personFrames: number; shotHeld: boolean; personHeld: boolean;
}

export function frameClock(p: { shots: Shot[]; durationSec: number; contentSec?: number }, frame: number): FrameClock {
  const sec = frame / CANVAS.fps;
  const lastEnd = p.shots.length > 0 ? p.shots[p.shots.length - 1].end : p.durationSec;
  const durationFrames = Math.round(p.durationSec * CANVAS.fps);
  const shotFrames = Math.min(Math.round(lastEnd * CANVAS.fps), durationFrames);
  const personFrames = Math.min(Math.round((p.contentSec ?? lastEnd) * CANVAS.fps), shotFrames);
  const shotHeld = frame >= shotFrames;
  const personHeld = frame >= personFrames;
  return {
    sec, shotFrames, personFrames, shotHeld, personHeld,
    visualSec: shotHeld ? (shotFrames - 1) / CANVAS.fps : sec,
    personSec: personHeld ? (personFrames - 1) / CANVAS.fps : sec,
  };
}
