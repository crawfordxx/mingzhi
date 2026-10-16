// 整片自检的真实渲染部分：铺图卡片文字对比度（显示 / 隐去文字两张静帧相减）、压暗后复测；卡片自带生成图的「AI 生成」角标
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderStill, selectComposition } from '@remotion/renderer';
import { loadConfig } from '../src/config.js';
import { withBundle } from '../src/compose/render.js';
import { run, runBuffer } from '../src/media/exec.js';
import { measureReadability } from '../src/qa/readability.js';
import { planRedo } from '../src/qa/film-redo.js';
import type { FilmReport } from '../src/qa/film.js';
import type { Broll, CardSpec, Shot, Storyboard } from '../src/storyboard/schema.js';

const cfg = loadConfig({});
const workDir = mkdtempSync(join(tmpdir(), 'mz-film-render-'));
const WHITE: Broll = { file: 'broll/white.png', kind: 'photo', focal: { x: 0.5, y: 0.5 } };
const GRAY: Broll = { file: 'broll/gray.png', kind: 'photo', focal: { x: 0.5, y: 0.5 } };
const hook: CardSpec = { template: 'hook', props: { index: 1, total: 1, headline: '白字压在亮图上看不清', highlight: [] } };
const list: CardSpec = { template: 'evidenceList', props: { title: '玻璃卡上的深色字', rows: [{ badge: '要点', text: '第一条' }, { badge: '要点', text: '第二条' }] } };
const sb = (shots: Shot[]): Storyboard => ({ shots, bgm: 'chill' });

beforeAll(async () => {
  mkdirSync(join(workDir, 'broll'));
  await run(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xF4F4F2:s=1080x960', '-frames:v', '1', join(workDir, WHITE.file)]);
  await run(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x8A8A8A:s=1080x960', '-frames:v', '1', join(workDir, GRAY.file)]);
  await run(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2E5A3C:s=1080x960', '-frames:v', '1', join(workDir, 'broll/gen.png')]);
}, 60_000);

describe('铺图卡片可读性（真实渲染）', () => {
  it('白字钩子压在亮图上对比度不够（浅色字）；按量到的对比度压暗底图后复测达标；玻璃卡上的深色字达标', async () => {
    const shots: Shot[] = [
      { start: 0, end: 3, layout: 'split', card: hook, broll: WHITE },
      { start: 3, end: 6, layout: 'full' },
      { start: 6, end: 10, layout: 'split', card: list, broll: GRAY },
    ];
    const before = await measureReadability({ workDir, storyboard: sb(shots), ffmpeg: cfg.ffmpeg });
    expect(before.map((c) => c.shotIndex)).toEqual([0, 2]);
    expect(before[0].contrast).toBeLessThan(4.5);
    expect(before[0].polarity).toBe('light');
    expect(before[1].contrast).toBeGreaterThanOrEqual(4.5);
    const report: FilmReport = { ok: false, durationSec: 10, metrics: [{ id: 'readability', label: '', value: before[0].contrast, limit: 4.5, ok: false, detail: '', shots: [0] }], templates: [], skipped: [], contrasts: before };
    const plan = planRedo(sb(shots), report, [], 10);
    expect(plan.actions.map((a) => a.kind)).toEqual(['dim']);
    expect(plan.storyboard.shots.slice(1)).toEqual(shots.slice(1));
    const after = await measureReadability({ workDir, storyboard: plan.storyboard, ffmpeg: cfg.ffmpeg });
    expect(after[0].contrast).toBeGreaterThanOrEqual(4.5);
  }, 180_000);
});

describe('卡片自带生成图的「AI 生成」角标', () => {
  /** 钩子卡（自带图）右上角区域的 RGB */
  async function corner(card: CardSpec, serveUrl: string, out: string): Promise<Uint8Array> {
    const inputProps = { card, dur: 2 };
    const composition = await selectComposition({ serveUrl, id: 'CardStill', inputProps });
    await renderStill({ composition, serveUrl, inputProps, output: out, frame: 30, imageFormat: 'png' });
    const buf = await runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', out, '-vf', 'crop=200:60:840:76', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return new Uint8Array(buf);
  }
  it('带 mediaLabel 时右上角出现角标（与镜头 B-roll 角标同一位置与样式）；不带时没有', async () => {
    const base: CardSpec = { template: 'hook', props: { index: 1, total: 1, headline: '生成图做底的钩子', highlight: [], image: 'broll/gen.png' } };
    const labeled: CardSpec = { template: 'hook', props: { ...base.props, mediaLabel: { kind: 'ai', text: 'AI 生成' } } } as CardSpec;
    const [a, b] = await withBundle(workDir, async (url) => [await corner(base, url, join(workDir, 'a.png')), await corner(labeled, url, join(workDir, 'b.png'))]);
    const changed = a.reduce((n, v, i) => n + (Math.abs(v - b[i]) > 30 ? 1 : 0), 0);
    expect(changed).toBeGreaterThan(300);
    // 角标的字是浅色（白字压在半透明深底上）
    const bright = Array.from({ length: b.length / 3 }, (_, i) => Math.min(b[i * 3], b[i * 3 + 1], b[i * 3 + 2])).filter((v) => v > 200).length;
    expect(bright).toBeGreaterThan(50);
  }, 180_000);
});
