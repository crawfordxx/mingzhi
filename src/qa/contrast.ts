const HEX_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** WCAG 2.x：sRGB 通道转线性值 */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const m = HEX_RE.exec(hex);
  if (!m) throw new Error(`颜色格式必须是 #RRGGBB：${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => linear(parseInt(h, 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度 (L1+0.05)/(L2+0.05)，范围 1–21，与前后景顺序无关 */
export function contrastRatio(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = '#FFFFFF';
/** 与 THEME.ink 同值（本文件不依赖 render，保持纯函数，可被渲染端与 qa 共用） */
const NEAR_BLACK = '#1C1B19';
const BLACK = '#000000';
const MIN_READABLE = 4.5;

/** 彩色底上的文字色：白或近黑里取对比度高的；仍不足 4.5 时退到纯黑（目前只有红底会走到这一步：白字不够、近黑字刚好差一点） */
export function readableOn(fill: string): string {
  const best = [WHITE, NEAR_BLACK].reduce((a, b) => (contrastRatio(b, fill) > contrastRatio(a, fill) ? b : a));
  return contrastRatio(best, fill) >= MIN_READABLE ? best : BLACK;
}

const channels = (hex: string): number[] => {
  if (!HEX_RE.test(hex)) throw new Error(`颜色格式必须是 #RRGGBB：${hex}`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
};

/** 半透明前景（alpha）叠在不透明底色上的结果，#RRGGBB 大写 */
export function blend(fg: string, alpha: number, base: string): string {
  const [f, b] = [channels(fg), channels(base)];
  return `#${f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** #RRGGBB + alpha → CSS rgba()，让半透明底的颜色也只在 THEME 里写一份 */
export function toRgba(hex: string, alpha: number): string {
  const [r, g, b] = channels(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
