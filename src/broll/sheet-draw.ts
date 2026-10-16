/** 联系表上的角标与空格标记：全用 drawbox 画，不依赖字体（ffmpeg 常不带 drawtext） */
export const CELL = 512;
const BADGE = { x: CELL - 92, y: 8, w: 84, h: 116, bg: '0xFFD60A', fg: 'black' } as const;
/** 七段数码管的粗细与数字区大小（在角标内留边） */
const DIGIT = { dx: 16, dy: 14, w: 52, h: 88, t: 11 } as const;
/** 取图失败的空格底色（深红）与「空」字颜色，和灰底 letterbox、正常画面都区分得开 */
export const BLANK_COLOR = '0x5A1E1E';
const BLANK_GLYPH = 'white';
const GLYPH_UNIT = 12;
const GLYPH_SIZE = 15 * GLYPH_UNIT;

interface Box { x: number; y: number; w: number; h: number }

const boxFilter = ({ x, y, w, h }: Box, color: string): string => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill`;

/** 七段 a-g 对应的矩形（相对数字区） */
function segmentBox(seg: string): Box {
  const { w, h, t } = DIGIT;
  const half = Math.floor(h / 2);
  const vertical = { w: t, h: half + Math.ceil(t / 2) };
  const mid = half - Math.floor(t / 2);
  const boxes: Record<string, Box> = {
    a: { x: 0, y: 0, w, h: t },
    b: { x: w - t, y: 0, ...vertical },
    c: { x: w - t, y: mid, ...vertical },
    d: { x: 0, y: h - t, w, h: t },
    e: { x: 0, y: mid, ...vertical },
    f: { x: 0, y: 0, ...vertical },
    g: { x: 0, y: mid, w, h: t },
  };
  return boxes[seg];
}

const SEGMENTS = ['', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgecd', 'abc', 'abcdefg', 'abcdfg'];

/** 角标的 drawbox 滤镜串：亮黄底 + 黑色数码管数字。底色高对比，缩略后仍能读 */
export function badgeFilter(digit: number): string {
  const segs = [...SEGMENTS[digit]].map((s) => {
    const b = segmentBox(s);
    return boxFilter({ x: BADGE.x + DIGIT.dx + b.x, y: BADGE.y + DIGIT.dy + b.y, w: b.w, h: b.h }, BADGE.fg);
  });
  return [boxFilter(BADGE, BADGE.bg), ...segs].join(',');
}

/** 「空」字的方块笔画（15×15 网格）：宀 + 八 + 工 */
const GLYPH_STROKES: readonly Box[] = [
  { x: 7, y: 0, w: 2, h: 2 }, { x: 1, y: 2, w: 13, h: 2 }, { x: 1, y: 2, w: 2, h: 4 }, { x: 12, y: 2, w: 2, h: 4 },
  { x: 6, y: 5, w: 2, h: 3 }, { x: 4, y: 8, w: 2, h: 2 }, { x: 8, y: 5, w: 2, h: 3 }, { x: 10, y: 8, w: 2, h: 2 },
  { x: 3, y: 10, w: 9, h: 2 }, { x: 7, y: 12, w: 2, h: 1 }, { x: 1, y: 13, w: 13, h: 2 },
];

/** 空格标记：画面正中的白色「空」字（空格整格底色是 BLANK_COLOR） */
export function blankMarkFilter(): string {
  const origin = (CELL - GLYPH_SIZE) / 2;
  return GLYPH_STROKES
    .map((s) => boxFilter({ x: origin + s.x * GLYPH_UNIT, y: origin + s.y * GLYPH_UNIT, w: s.w * GLYPH_UNIT, h: s.h * GLYPH_UNIT }, BLANK_GLYPH))
    .join(',');
}
