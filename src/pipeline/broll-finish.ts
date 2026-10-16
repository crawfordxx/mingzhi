import { readAssetMeta, storyboardFiles, writeAssetMeta, writeStoryboardCredits, type AssetMeta } from '../broll/credit-store.js';
import { existingFiles, type BrollAsset } from '../broll/fulfill.js';
import { GENERATED_LICENSE, SCREENSHOT_LICENSE } from '../broll/paid.js';
import { visualLayout } from '../compose/layout.js';
import { normalizeStoryboard } from '../storyboard/normalize.js';
import { storyboardIssues } from '../storyboard/rules.js';
import type { Storyboard } from '../storyboard/schema.js';

const SOURCE: Record<BrollAsset['source'], AssetMeta['credit']['source']> = { generate: 'generated', video: 'generated', screenshot: 'screenshot', pexels: 'pexels' };
const PEXELS_LICENSE = 'Pexels License';

/** 卡片素材（钩子图、图片卡、网页截图、图生视频）的授权记录：生成的标 AI 生成，截图记网址；已有记录不覆盖 */
export function recordCardAssets(workDir: string, assets: readonly BrollAsset[], fetchedAt = new Date().toISOString()): void {
  for (const a of assets) {
    if (readAssetMeta(workDir, a.file)) continue;
    const source = SOURCE[a.source];
    const license = source === 'generated' ? GENERATED_LICENSE : source === 'screenshot' ? SCREENSHOT_LICENSE : PEXELS_LICENSE;
    const page = source === 'screenshot' ? a.url ?? '' : source === 'pexels' ? 'https://www.pexels.com' : 'AI 生成';
    writeAssetMeta(workDir, a.file, {
      credit: { file: a.file, source, page, license, attributionRequired: source === 'screenshot', aiGenerated: source === 'generated', modified: [], query: '', fetchedAt },
      candidateId: `card:${a.key}`, kind: /\.mp4$/.test(a.file) ? 'video' : 'photo', focal: { x: 0.5, y: 0.5 },
    });
  }
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
