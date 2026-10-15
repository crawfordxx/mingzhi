/** 人物放置区（0–1，相对画布）：底图在这里留白，合成时人物等比放入并底对齐 */
export interface PersonSlot { x: number; y: number; w: number; h: number }

/** 人物抠像的修饰：描边、投影（CSS drop-shadow 参数）、双色调（[暗部色, 亮部色]） */
export interface PersonStyle { outline?: { px: number; color: string }; shadow?: string; duotone?: readonly [string, string] }

export interface CoverStyle {
  /** 中文名 */
  name: string;
  /** 风格描述：配色、构图、材质、字体气质（拼进生图提示词） */
  prompt: string;
  personSlot: PersonSlot;
  personStyle: PersonStyle;
}

/** 三种留白方位，提示词里的方位描述由 slotRegion 从坐标推出，保证二者一致 */
const BOTTOM_RIGHT: PersonSlot = { x: 0.48, y: 0.34, w: 0.52, h: 0.66 };
const RIGHT: PersonSlot = { x: 0.5, y: 0.12, w: 0.5, h: 0.88 };
const BOTTOM_CENTER: PersonSlot = { x: 0.2, y: 0.4, w: 0.6, h: 0.6 };

const DEFS = {
  bauhaus: {
    name: '包豪斯',
    prompt: '包豪斯（Bauhaus）风格：正红、明黄、钴蓝与黑色的几何色块（圆、方、三角）与粗网格构图，米白纸底，粗体无衬线中文标题，构成主义的严谨排版，丝网印刷海报质感',
    personSlot: BOTTOM_RIGHT,
    personStyle: { shadow: '16px 16px 0 rgba(17,17,17,0.9)' },
  },
  swiss: {
    name: '瑞士国际主义',
    prompt: '瑞士国际主义（Swiss International Typographic Style）风格：严格的模块化网格，红、黑、白三色，Helvetica 气质的超大粗体无衬线中文标题，左对齐、不对称构图，细线分隔，大面积纯色与留白',
    personSlot: RIGHT,
    personStyle: { shadow: '0 18px 36px rgba(0,0,0,0.3)' },
  },
  memphis: {
    name: '孟菲斯',
    prompt: '孟菲斯（Memphis Design）风格：粉红、薄荷绿、明黄、电光蓝撞色，波点、波浪线、锯齿线与彩色几何碎片散布，俏皮活泼，圆润的粗体中文标题',
    personSlot: BOTTOM_CENTER,
    personStyle: { outline: { px: 8, color: '#FFFFFF' }, shadow: '10px 10px 0 #1A1A1A' },
  },
  editorial: {
    name: '杂志极简',
    prompt: '高端杂志极简（editorial minimal）风格：大面积留白，高级灰与暖米色调，精致的细线与网格，细高反差衬线中文大标题（宋体、Didone 气质），克制优雅的版式',
    personSlot: RIGHT,
    personStyle: { shadow: '0 24px 48px rgba(40,36,30,0.28)' },
  },
  neon: {
    name: '赛博霓虹',
    prompt: '赛博朋克霓虹（cyberpunk neon）风格：深海军蓝到纯黑的暗底，青色与品红霓虹光、发光线条、扫描线与轻微故障（glitch）效果，科技感，标题为发光的粗体无衬线中文',
    personSlot: BOTTOM_RIGHT,
    personStyle: { outline: { px: 3, color: '#22E5FF' }, shadow: '0 0 28px rgba(34,229,255,0.85)' },
  },
  guochao: {
    name: '国潮',
    prompt: '国潮风格：朱红与金色为主色，祥云纹、回纹与水墨笔触点缀，宣纸纹理，书法感的大号中文标题，传统元素与现代海报构图结合',
    personSlot: RIGHT,
    personStyle: { outline: { px: 4, color: '#F2C66D' }, shadow: '0 18px 36px rgba(90,10,0,0.45)' },
  },
  risograph: {
    name: '孔版印刷',
    prompt: '孔版印刷（Risograph）风格：荧光粉与群青两色套印，颗粒网点质感，套色轻微错位，粗糙的纸张纹理，粗体中文标题带印刷错版感',
    personSlot: BOTTOM_RIGHT,
    personStyle: { duotone: ['#1F3A93', '#FF8FC2'] },
  },
  neobrutal: {
    name: '新粗野主义',
    prompt: '新粗野主义（Neo-brutalism）风格：明黄、亮蓝、粉红等高饱和纯色大色块，粗黑描边，无模糊的黑色硬投影，方正的卡片式布局，超粗黑体中文标题',
    personSlot: BOTTOM_RIGHT,
    personStyle: { outline: { px: 8, color: '#000000' }, shadow: '14px 14px 0 #000000' },
  },
  y2k: {
    name: '千禧 Y2K',
    prompt: '千禧 Y2K 风格：蓝紫到粉的渐变背景，铬金属质感（chrome）的立体中文标题，透明气泡、闪光星形与液态金属元素，复古未来感',
    personSlot: BOTTOM_CENTER,
    personStyle: { outline: { px: 4, color: '#FFFFFF' }, shadow: '0 0 28px rgba(186,140,255,0.85)' },
  },
  japanese: {
    name: '日系清新',
    prompt: '日系清新风格：奶白、浅蓝、淡绿的浅色调，柔和的自然光感，胶片颗粒，留白充足，纤细的中文标题，小标题用柔和的手写感字体',
    personSlot: RIGHT,
    personStyle: { shadow: '0 14px 30px rgba(60,80,100,0.22)' },
  },
} as const satisfies Record<string, CoverStyle>;

export type CoverStyleId = keyof typeof DEFS;
export const COVER_STYLES: Record<CoverStyleId, CoverStyle> = DEFS;
export const DEFAULT_COVER_STYLE: CoverStyleId = 'bauhaus';

/** 封面合成（Remotion Cover34/Cover43）的输入；bg 与 person 是相对 publicDir（工作目录）的文件名，person 为空时不放人物 */
export type CoverProps = { bg: string; person: string; style: CoverStyleId };

/** 从放置区坐标推出提示词里的方位：人物留白在哪、标题放在哪 */
export function slotRegion(slot: PersonSlot): { blank: string; title: string } {
  const cx = slot.x + slot.w / 2;
  if (cx >= 0.4 && cx <= 0.6) return { blank: '底部居中', title: '上方居中' };
  const [side, opposite] = cx > 0.6 ? ['右', '左'] : ['左', '右'];
  return slot.h >= 0.8 ? { blank: `${side}侧`, title: `${opposite}上方` } : { blank: `${side}下角`, title: `${opposite}上角` };
}
