// 生成项目统一调色 LUT：assets/lut/mingzhi-warm.cube（33³，Adobe/Resolve .cube 格式，ffmpeg lut3d 可直接读）
// 用法：node scripts/make-lut.mjs [输出路径]
//
// 目标：所有 B-roll 看起来像「同一个摄影师、同一部片」——暖中性、低饱和、柔高光、轻微 S 曲线，
// 阴影略偏青绿、高光略偏暖；统一而不脏（不灰、不闷、肤色干净）。
// 输入输出都是 sRGB 编码值（显示参考，与 ffmpeg lut3d 在 RGB 像素上的取值一致），运算按以下顺序：
//   1. 拆分：亮度 Y（Rec.709 系数，编码域）+ 色度向量 C = RGB − Y
//   2. 影调曲线（只作用在亮度上，色相不变）：单调三次插值，控制点见 TONE
//        黑位抬到 0.022（轻微哑光，不发灰）；暗部压一点、中间调斜率 >1（轻 S）；
//        0.75 以上肩部滚降，纯白落在 0.955（柔高光，不硬切）
//   3. 色度：随亮度变化按比例缩放（暗处不过饱和），再做「软压缩」 m' = SAT·m / (1 + KNEE·m)
//        低饱和颜色约保留 80%，高饱和颜色（霓虹、纯色）压到约 55%，于是不同来源的素材饱和度被拉齐；
//        极暗和高光区再额外减饱和（HI_DESAT、LO_DESAT），高光不出彩边、暗部不脏；
//        减掉的色度按 HK_LIFT 补回一点亮度（纯红、纯蓝减饱和后不发闷）
//   4. 色相微调：蓝向青偏一点、绿向橄榄偏一点并减饱和（图库素材最「廉价」的两种颜色）
//   5. 分离色调：阴影加青绿（SHADOW_TINT），高光加暖（HIGHLIGHT_TINT），中间调整体微暖（MID_WARM）；
//        各偏移先减去自身亮度分量，只改色温不改明暗
// 所有参数集中在下面的常量里，改动后重跑脚本即可；测试 tests/broll-process.test.ts 会检查方向是否正确。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIZE = 33;
/** 影调曲线控制点（输入亮度 → 输出亮度） */
export const TONE = [[0, 0.022], [0.1, 0.082], [0.25, 0.215], [0.5, 0.505], [0.75, 0.772], [0.9, 0.888], [1, 0.955]];
/** 色度软压缩：整体保留系数与拐点 */
export const SAT = 0.84;
export const KNEE = 0.8;
/** 高光（Y>0.75）与暗部（Y<0.18）的额外减饱和上限 */
export const HI_DESAT = 0.22;
export const LO_DESAT = 0.15;
/** 分离色调偏移（RGB，编码域 0–1） */
export const SHADOW_TINT = [-0.012, 0.004, 0.01];
export const HIGHLIGHT_TINT = [0.016, 0.004, -0.018];
export const MID_WARM = [0.009, 0.002, -0.011];
/** 色相微调：蓝→青的混入量、绿色减饱和量 */
export const BLUE_TO_CYAN = 0.12;
export const GREEN_DESAT = 0.18;
/** 减掉的色度按此比例补回亮度（Helmholtz–Kohlrausch 补偿）：纯色减饱和后不至于发闷变暗 */
export const HK_LIFT = 0.2;

const WR = 0.2126, WG = 0.7152, WB = 0.0722;
const luma = (r, g, b) => WR * r + WG * g + WB * b;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Fritsch–Carlson 单调三次插值：曲线不会过冲，保证亮度单调 */
function monotoneCurve(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const n = xs.length;
  const d = xs.slice(0, -1).map((x, i) => (ys[i + 1] - ys[i]) / (xs[i + 1] - x));
  const m = xs.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2));
  for (let i = 0; i < n - 1; i += 1) {
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { m[i] = (3 * a * d[i]) / Math.sqrt(s); m[i + 1] = (3 * b * d[i]) / Math.sqrt(s); }
  }
  return (x) => {
    const i = Math.min(n - 2, Math.max(0, xs.findIndex((v, k) => k > 0 && x <= v) - 1));
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1, h10 = t ** 3 - 2 * t ** 2 + t, h01 = -2 * t ** 3 + 3 * t ** 2, h11 = t ** 3 - t ** 2;
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
  };
}

const tone = monotoneCurve(TONE);

/** 蓝向青偏、绿向橄榄偏并减饱和；按「该颜色有多蓝/多绿」加权，中性色不受影响 */
function hueTweak([r, g, b]) {
  const blue = clamp01(b - Math.max(r, g));
  const green = clamp01(g - Math.max(r, b));
  const g2 = g + blue * BLUE_TO_CYAN;
  const y = luma(r, g2, b);
  const k = 1 - green * GREEN_DESAT * 2;
  return [y + (r - y) * k + green * 0.04, y + (g2 - y) * k, y + (b - y) * k];
}

/** 偏移去掉亮度分量，只改色温 */
const chromaOnly = (v, w) => {
  const y = luma(...v);
  return v.map((c) => (c - y) * w);
};

export function grade(rgb) {
  const [r, g, b] = hueTweak(rgb);
  const y = luma(r, g, b);
  const y2 = tone(y);
  const c = [r - y, g - y, b - y];
  const m = Math.hypot(...c);
  const follow = Math.min(1.25, Math.max(0.75, y2 / Math.max(y, 1e-4)));
  const soft = m > 1e-6 ? (SAT / (1 + KNEE * m)) : SAT;
  const extra = 1 - HI_DESAT * smooth(0.75, 1, y2) - LO_DESAT * (1 - smooth(0, 0.18, y2));
  const k = follow * soft * extra;
  const yOut = y2 + HK_LIFT * m * Math.max(0, follow - k) * smooth(0, 0.1, y2) * (1 - smooth(0.55, 0.9, y2));
  const sh = chromaOnly(SHADOW_TINT, (1 - smooth(0.05, 0.5, y2)) * smooth(0, 0.06, y2));
  const hi = chromaOnly(HIGHLIGHT_TINT, smooth(0.5, 0.95, y2));
  const mid = chromaOnly(MID_WARM, 1 - Math.abs(y2 - 0.5) * 2);
  return [0, 1, 2].map((i) => clamp01(yOut + c[i] * k + sh[i] + hi[i] + mid[i]));
}

/** .cube 规定红色变化最快：外层 b、中层 g、内层 r */
export function makeCube(size = SIZE) {
  const lines = ['TITLE "mingzhi-warm"', '# 明知 AI 剪辑项目 LUT：暖中性、低饱和、柔高光、轻 S 曲线；生成脚本 scripts/make-lut.mjs', `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  for (let bi = 0; bi < size; bi += 1) {
    for (let gi = 0; gi < size; gi += 1) {
      for (let ri = 0; ri < size; ri += 1) {
        const out = grade([ri / (size - 1), gi / (size - 1), bi / (size - 1)]);
        lines.push(out.map((v) => v.toFixed(6)).join(' '));
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const out = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'lut', 'mingzhi-warm.cube');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, makeCube());
  console.log(`已生成 ${out}`);
}
