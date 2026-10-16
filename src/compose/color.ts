/** 0–1 的 RGB（编码域）与 HSL 互转、转 #RRGGBB；片色推导用 */
export interface Rgb { r: number; g: number; b: number }
export interface Hsl { h: number; s: number; l: number }

/** RGB → HSL：h 为 0–360 度，s、l 为 0–1 */
export function hslOf({ r, g, b }: Rgb): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: Math.min(1, s), l };
}

/** HSL → RGB */
export function rgbOfHsl({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return { r: r + m, g: g + m, b: b + m };
}

const byte = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');

/** HSL 或 RGB → #RRGGBB（大写） */
export function hexOf(c: Hsl | Rgb): string {
  const rgb = 'h' in c ? rgbOfHsl(c) : c;
  return `#${byte(rgb.r)}${byte(rgb.g)}${byte(rgb.b)}`.toUpperCase();
}

/** #RRGGBB → 0–1 RGB */
export function rgbOfHex(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`颜色格式必须是 #RRGGBB：${hex}`);
  return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
}
