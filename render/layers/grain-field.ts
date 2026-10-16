/**
 * 颗粒强度：噪声的均方根占满幅（255）的比例，1% ≈ 2.6 灰阶。
 * 依据：同一张肤色人像 1:1 对比 0.6% / 1.0% / 1.5%，0.6% 看不出，1.0% 只在大片平坦区（米色卡底、虚化背景）里隐约可见，1.5% 在肤色上已经能看出毛糙；
 * 取 1.0%，是「肉眼刚能察觉」的一档（亮度噪声的可见阈值约 1%）。老版的平均偏差是 3.5%（约 9 灰阶，均方根约 11 灰阶），是现在的 4 倍多，还带色
 */
export const GRAIN_STRENGTH = 0.01;
/** 暗角：四角最多压暗的比例 */
export const VIGNETTE = 0.16;
/** 固定种子：同一帧号永远出同一张噪声，渲染可复现 */
export const GRAIN_SEED = 0x6d7a6869;
/** 人物区域内的颗粒强度倍数（1/3） */
export const PERSON_GRAIN_GAIN = 1 / 3;
/** 人物区域边缘的羽化宽度（像素）：颗粒强度在这么宽的范围内渐变，避免出现一圈可见的边 */
export const PERSON_FEATHER_PX = 48;

/** 画布像素下的人物区域 */
export interface PixelRegion { x: number; y: number; w: number; h: number }

/** mulberry32：32 位种子的小型伪随机数发生器 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 均匀分布噪声的峰峰值（灰阶）：σ = 峰峰值 / √12 */
export const grainSpan = (strength: number): number => strength * 255 * Math.sqrt(12);

/**
 * 噪声叠加后在中灰处的平均抬升 = 峰峰值的一半。用一层同量的黑色半透明（alpha = 抬升 / 128）把中灰拉回原位，
 * 这样颗粒不改变画面的平均亮度（只是黑位和高光各收进约 3 灰阶）
 */
export const grainLift = (strength: number): number => grainSpan(strength) / 2 / 128;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 一维羽化：区域内为 1，区域外 feather 像素内渐降到 0（再外面是 0） */
function ramp(n: number, from: number, to: number, feather: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const center = i + 0.5;
    out[i] = clamp01((center - (from - feather)) / feather) * clamp01((to + feather - center) / feather);
  }
  return out;
}

/** 每个像素的颗粒强度倍数：人物区域内为 gain，区域外为 1，边缘羽化；区域为空时全为 1（返回 null 表示处处为 1） */
export function grainWeights(width: number, height: number, region: PixelRegion | null, gain = PERSON_GRAIN_GAIN, feather = PERSON_FEATHER_PX): { wx: Float32Array; wy: Float32Array; gain: number } | null {
  if (!region || region.w <= 0 || region.h <= 0) return null;
  return { wx: ramp(width, region.x, region.x + region.w, feather), wy: ramp(height, region.y, region.y + region.h, feather), gain };
}

/**
 * 帧号 + 种子 → 灰度噪声（RGBA，R=G=B，alpha 255），1 像素 1 颗粒。
 * 噪声是 [0, 峰峰值] 的均匀分布，配合浏览器的 plus-lighter（逐通道相加）叠到画面上：三个通道加同样的数，只改亮度、不改色。
 * 人物区域里不改均值、只缩小波动（w 倍），所以区域边缘没有亮度台阶。
 */
export function grainField(frame: number, width: number, height: number, opts: { strength?: number; seed?: number; region?: PixelRegion | null } = {}): Uint8ClampedArray {
  const span = grainSpan(opts.strength ?? GRAIN_STRENGTH);
  const mid = span / 2;
  const rand = mulberry32(Math.imul(frame + 1, 0x9e3779b1) ^ (opts.seed ?? GRAIN_SEED));
  const weights = grainWeights(width, height, opts.region ?? null);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const wy = weights ? weights.wy[y] : 0;
    for (let x = 0; x < width; x += 1) {
      const inside = weights ? weights.wx[x] * wy : 0;
      const w = 1 - (1 - (weights?.gain ?? 1)) * inside;
      const v = mid + w * span * (rand() - 0.5);
      const i = (y * width + x) * 4;
      out[i] = v;
      out[i + 1] = v;
      out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return out;
}
