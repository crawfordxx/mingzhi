import { readAssetMeta, storyboardFiles, writeAssetMeta, writeStoryboardCredits, type AssetMeta } from '../broll/credit-store.js';
import { existingFiles, type BrollAsset } from '../broll/fulfill.js';
import { GENERATED_LICENSE, SCREENSHOT_LICENSE } from '../broll/paid.js';
import { visualLayout } from '../compose/layout.js';
import { normalizeStoryboard } from '../storyboard/normalize.js';
import { applyStoryboardRules, storyboardIssues } from '../storyboard/rules.js';
import type { Storyboard } from '../storyboard/schema.js';

const SOURCE: Record<BrollAsset['source'], AssetMeta['credit']['source']> = { generate: 'generated', video: 'generated', screenshot: 'screenshot', pexels: 'pexels' };
const PEXELS_LICENSE = 'Pexels License';

/** 卡片素材（钩子图、图片卡、网页截图、图生视频）的授权记录：生成的标 AI 生成，截图记网址；已有记录不覆盖 */
export function recordCardAssets(workDir: string, assets: readonly BrollAsset[], fetchedAt = new Date().toISOString()): void {
  for (const a of assets) {
    if (readAssetMeta(workDir, a.file)) continue;
    const source = SOURCE[a.source];
    const license = source === 'generated' ? GENERATED_LICENSE : source === 'screenshot' ? SCREENSHOT_LICENSE : PEXELS_LICENSE;
    const page = source === 'screenshot' ? a.url ?? '' : source === 'pexels' ? a.page ?? 'https://www.pexels.com' : 'AI 生成';
    const author = source === 'pexels' && a.author ? { author: a.author, ...(a.authorUrl ? { authorUrl: a.authorUrl } : {}) } : {};
    writeAssetMeta(workDir, a.file, {
      credit: { file: a.file, source, page, ...author, license, attributionRequired: source === 'screenshot', aiGenerated: source === 'generated', modified: [], query: '', fetchedAt },
      candidateId: `card:${a.key}`, kind: /\.mp4$/.test(a.file) ? 'video' : 'photo', focal: { x: 0.5, y: 0.5 },
    });
  }
}

const AI_LABEL = { kind: 'ai', text: 'AI 生成' } as const;

/** 卡片自带的图或视频（钩子、图片卡）按授权记录加画面角标：AI 生成的标「AI 生成」（与镜头 B-roll 的角标同一视觉）；其余与已有角标原样 */
export function labelCardMedia(storyboard: Storyboard, workDir: string): Storyboard {
  const shots = storyboard.shots.map((s) => {
    const card = s.card;
    if (!card || (card.template !== 'hook' && card.template !== 'photo') || card.props.mediaLabel) return s;
    const file = card.props.video ?? card.props.image;
    if (!file || !readAssetMeta(workDir, file)?.credit.aiGenerated) return s;
    return { ...s, card: { ...card, props: { ...card.props, mediaLabel: AI_LABEL } } } as Storyboard['shots'][number];
  });
  return shots.some((s, i) => s !== storyboard.shots[i]) ? { ...storyboard, shots } : storyboard;
}

/**
 * 编排后复检多样性并修正：Task 6 的规则在 B-roll 编排之前套过一次，编排（切卡、铺图、插入）之后分镜变了，再套一次。
 * 不改时间轴；带素材的镜头去卡片时保留素材；fixes 为修正前违反的规则
 */
export function rebalance(storyboard: Storyboard, durationSec: number): { storyboard: Storyboard; fixes: string[] } {
  const r = applyStoryboardRules(storyboard.shots, durationSec);
  return { storyboard: r.shots === storyboard.shots ? storyboard : { ...storyboard, shots: r.shots }, fixes: r.fixes };
}

/** 卡片上还没有图或视频的素材需求（visual）去掉 */
function dropPending(storyboard: Storyboard): Storyboard {
  const shots = storyboard.shots.map((s) => {
    const p = (s.card?.props ?? {}) as { image?: string; video?: string; visual?: unknown };
    if (!s.card || p.visual === undefined || p.image || p.video) return s;
    const { visual: _v, ...props } = p;
    return { ...s, card: { ...s.card, props } } as Storyboard['shots'][number];
  });
  return { ...storyboard, shots };
}

/** 素材步骤意外失败时的降级：已有文件的素材（卡片图、B-roll，含父版本已付费的）全部保留，只去掉还没取到的需求 */
export function keepExisting(storyboard: Storyboard, workDir: string, durationSec: number): Storyboard {
  const pending = dropPending(storyboard);
  // 已付费生成、留在卡片上的图同样要标「AI 生成」
  return labelCardMedia(normalizeStoryboard(pending, durationSec, existingFiles(pending, workDir)).storyboard, workDir);
}

/** 最后一次归一化：可用文件 = 分镜里已有的卡片素材与 B-roll（都在 workDir 里） */
export function finalize(storyboard: Storyboard, workDir: string, durationSec: number): Storyboard {
  return normalizeStoryboard(storyboard, durationSec, existingFiles(storyboard, workDir)).storyboard;
}

export interface BrollMix { total: number; footage: number; photo: number; screenshot: number; generated: number; full: number; seconds: number }

/** 分镜里 B-roll 的构成：实拍（图库视频）、图片（图库照片）、截图、AI 生成，全屏插入次数与镜头素材总时长 */
export function brollMix(storyboard: Storyboard, workDir: string): BrollMix {
  const metas = storyboardFiles(storyboard).flatMap((f) => { const m = readAssetMeta(workDir, f); return m ? [m] : []; });
  const stock = metas.filter((m) => ['pexels', 'pixabay', 'openverse', 'wikimedia'].includes(m.credit.source));
  const withBroll = storyboard.shots.filter((s) => s.broll && visualLayout(s) !== 'full');
  return {
    total: metas.length,
    footage: stock.filter((m) => m.kind === 'video').length,
    photo: stock.filter((m) => m.kind === 'photo').length,
    screenshot: metas.filter((m) => m.credit.source === 'screenshot').length,
    generated: metas.filter((m) => m.credit.source === 'generated').length,
    full: withBroll.filter((s) => visualLayout(s) === 'broll').length,
    seconds: withBroll.reduce((n, s) => n + s.end - s.start, 0),
  };
}

/** 放好素材后的整片复检（Task 6 的多样性规则 + B-roll 自己的检查）：只报告，不改分镜 */
export function recheck(storyboard: Storyboard, durationSec: number): string[] {
  const shots = storyboard.shots;
  const files = shots.flatMap((s) => (s.broll ? [s.broll.file] : []));
  const reused = files.filter((f, i) => files.indexOf(f) !== i);
  const longFull = shots.filter((s) => visualLayout(s) === 'broll' && s.end - s.start > 3.5 + 1e-3);
  return [
    ...storyboardIssues(shots, durationSec),
    ...(reused.length > 0 ? [`同一素材用了多次：${[...new Set(reused)].join('、')}`] : []),
    ...longFull.map((s) => `全屏插入 ${s.start.toFixed(1)}–${s.end.toFixed(1)} 秒超过 3.5 秒`),
  ];
}

/** 写 credits.json（分镜实际用到的素材） */
export function writeCredits(storyboard: Storyboard, workDir: string, outDir: string): string {
  return writeStoryboardCredits(storyboard, workDir, outDir);
}

/** 一句话汇总 */
export function mixSummary(mix: BrollMix, placed: number, beats: number, costYuan: number, failures: number): string {
  const head = `素材 ${mix.total} 个（实拍 ${mix.footage} / 图片 ${mix.photo} / 截图 ${mix.screenshot} / 生成 ${mix.generated}）`;
  const beatPart = beats > 0 ? ` · 节拍 ${placed}/${beats} 放进镜头 · 全屏插入 ${mix.full} 次` : '';
  return `${head}${beatPart} · 花费 ¥${costYuan.toFixed(2)} · 失败 ${failures} 个`;
}
