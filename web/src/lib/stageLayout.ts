/**
 * 画框内的摆位：9:16 浮窗靠右，深色终端叠在它左下并只压住浮窗左缘一小条，
 * 既保留 G1 的「叠放」，又不挡字幕示意与播放控件。全部按画框实际尺寸计算。
 */
export const PLAYER_CHROME = 36 + 74;
const PAD = 40;
const OVERLAP = 40;

export interface StageLayout { h: number; w: number; left: number; top: number; term: { left: number; width: number; bottom: number } }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function stageLayout(frameW: number, frameH: number): StageLayout {
  const h = Math.max(240, Math.floor(frameH - 2 * PAD - PLAYER_CHROME));
  const w = Math.round((h * 9) / 16);
  const playerW = w + 16;
  const gap = clamp(frameW * 0.12, 40, 160);
  const left = Math.max(PAD, frameW - playerW - gap);
  const top = Math.round((frameH - h - PLAYER_CHROME) / 2);
  const width = clamp(left + OVERLAP - 24, 260, 400);
  return { h, w, left, top, term: { width, left: Math.max(16, left + OVERLAP - width), bottom: top + 74 + 22 } };
}
