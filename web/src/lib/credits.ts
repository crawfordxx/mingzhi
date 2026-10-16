/** 素材来源面板的纯逻辑：提示条件、来源名、加工项译名、摘要 */
import type { CreditItem, CreditMark, CreditSource } from '../api';

const SOURCE: Record<CreditSource, string> = {
  pexels: 'Pexels', pixabay: 'Pixabay', openverse: 'Openverse', wikimedia: 'Wikimedia Commons', screenshot: '网页截图', generated: 'AI 生成',
};
export const sourceLabel = (s: CreditSource): string => SOURCE[s];

/** CC BY：许可要求署名（Wikimedia 的 CC BY 系列）。BY-SA / CC0 / 图库自有许可不算 */
export const isCcBy = (item: CreditItem): boolean => item.attributionRequired && /^CC BY(?![-\w])/i.test(item.license);

/** text 是面板顶部的完整提示，short 是条目里的短版 */
export interface Notice { kind: 'ccby' | 'screenshot'; text: string; short: string }

const CCBY_NOTICE: Notice = { kind: 'ccby', text: 'CC BY 要求署名：发布时请附上署名文本（导出成功后可一键复制）', short: '需署名 · 见底部署名文本' };
const SHOT_NOTICE: Notice = { kind: 'screenshot', text: '网页截图：只截了页面与标题区，不含新闻图片本体，画面上已标注来源', short: '只截页面与标题区 · 画面已标注来源' };

export function noticeOf(item: CreditItem): Notice | undefined {
  if (item.source === 'screenshot') return SHOT_NOTICE;
  return isCcBy(item) ? CCBY_NOTICE : undefined;
}

/** 面板顶部的提示：出现过这类素材才显示，每类一条 */
export function panelNotices(items: readonly CreditItem[]): Notice[] {
  return [
    ...(items.some(isCcBy) ? [CCBY_NOTICE] : []),
    ...(items.some((i) => i.source === 'screenshot') ? [SHOT_NOTICE] : []),
  ];
}

const MODIFIED: Record<string, string> = {
  crop: '裁切', trim: '截取片段', lut: '调色', grade: '调色', color: '调色', wb: '白平衡', mute: '去音轨', fps30: '统一 30 帧',
};

/** 加工项译成中文，去重保持首次出现的顺序；不认识的原样保留 */
export function modifiedLabels(modified: readonly string[]): string[] {
  const names = modified.map((m) => {
    const speed = /^speed([\d.]+)$/.exec(m);
    return speed ? `慢放 ${speed[1]}×` : MODIFIED[m] ?? m;
  });
  return [...new Set(names)];
}

export function summaryOf(items: readonly CreditItem[]): string {
  if (items.length === 0) return '这一版没有用到外部素材';
  const count = (pred: (i: CreditItem) => boolean): number => items.filter(pred).length;
  const parts = [
    ['CC BY', count(isCcBy)], ['网页截图', count((i) => i.source === 'screenshot')], ['AI 生成', count((i) => i.aiGenerated || i.source === 'generated')],
  ] as const;
  return [`共 ${items.length} 条`, ...parts.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`)].join(' · ');
}

export const markText = (mark: CreditMark): string =>
  mark === 'replace' ? '已标记替换，下次改片时换一张' : '已标记删除，下次改片时去掉这一段素材';

/** 作品页的域名（去 www.），解析失败原样返回 */
export function hostOf(page: string): string {
  try {
    return new URL(page).hostname.replace(/^www\./, '');
  } catch {
    return page;
  }
}
