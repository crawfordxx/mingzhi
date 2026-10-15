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
