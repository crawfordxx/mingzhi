// 素材步骤收尾：卡片自带图的 AI 角标、Pexels 卡片兜底的作者记录、编排后复检多样性并修正（带素材的镜头不降级）
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepExisting, labelCardMedia, rebalance, recordCardAssets } from '../src/pipeline/broll-finish.js';
import { readAssetMeta } from '../src/broll/credit-store.js';
import { referenceColor } from '../src/broll/ref-color.js';
import { loadConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import { storyboardIssues } from '../src/storyboard/rules.js';
import type { Broll, CardSpec, Shot, Storyboard } from '../src/storyboard/schema.js';

const work = (): string => { const d = mkdtempSync(join(tmpdir(), 'mz-finish-')); mkdirSync(join(d, 'broll')); return d; };
const hook = (image?: string): CardSpec => ({ template: 'hook', props: { index: 1, total: 1, headline: '钩子', highlight: [], ...(image ? { image } : {}) } }) as CardSpec;
const photoCard = (image: string): CardSpec => ({ template: 'photo', props: { image, label: '配图' } });
const sb = (shots: Shot[]): Storyboard => ({ shots, bgm: 'chill' });

describe('卡片自带的图按授权记录加「AI 生成」角标', () => {
  it('生成的钩子图、图片卡加角标；Pexels 兜底不加；已有角标原样', () => {
    const dir = work();
    for (const f of ['gen.jpg', 'px.jpg', 'gen2.jpg']) writeFileSync(join(dir, 'broll', f), 'x');
    recordCardAssets(dir, [
      { key: 'gen', file: 'broll/gen.jpg', source: 'generate' },
      { key: 'gen2', file: 'broll/gen2.jpg', source: 'generate' },
      { key: 'px', file: 'broll/px.jpg', source: 'pexels', page: 'https://www.pexels.com/photo/1/', author: 'Ann Lee', authorUrl: 'https://www.pexels.com/@ann' },
    ]);
    const shots: Shot[] = [
      { start: 0, end: 3, layout: 'split', card: hook('broll/gen.jpg') },
      { start: 3, end: 6, layout: 'split', card: photoCard('broll/px.jpg') },
      { start: 6, end: 9, layout: 'split', card: photoCard('broll/gen2.jpg') },
      { start: 9, end: 12, layout: 'split', card: hook() },
    ];
    const out = labelCardMedia(sb(shots), dir).shots;
    expect(out[0].card).toMatchObject({ props: { mediaLabel: { kind: 'ai', text: 'AI 生成' } } });
    expect(out[1]).toEqual(shots[1]);
    expect(out[2].card).toMatchObject({ props: { mediaLabel: { kind: 'ai', text: 'AI 生成' } } });
    expect(out[3]).toEqual(shots[3]);
    // 素材步骤意外失败走回退时，留在卡片上的生成图也要标角标
    expect(keepExisting(sb(shots), dir, 12).shots[0].card).toMatchObject({ props: { mediaLabel: { kind: 'ai', text: 'AI 生成' } } });
    // Pexels 卡片兜底素材记下摄影师与作品页
    expect(readAssetMeta(dir, 'broll/px.jpg')?.credit).toMatchObject({ source: 'pexels', author: 'Ann Lee', authorUrl: 'https://www.pexels.com/@ann', page: 'https://www.pexels.com/photo/1/' });
  });

  it('图片卡与钩子用了网页截图：补「来源：<站点>」角标（与镜头 B-roll 的截图角标一致）', () => {
    const dir = work();
    writeFileSync(join(dir, 'broll', 'shot.png'), 'x');
    recordCardAssets(dir, [{ key: 'shot', file: 'broll/shot.png', source: 'screenshot', url: 'https://www.example.gov.cn/news/1.html' }]);
    const shots: Shot[] = [
      { start: 0, end: 3, layout: 'split', card: photoCard('broll/shot.png') },
      { start: 3, end: 6, layout: 'split', card: hook('broll/shot.png') },
    ];
    const out = labelCardMedia(sb(shots), dir).shots;
    expect(out[0].card).toMatchObject({ props: { mediaLabel: { kind: 'source', text: '来源：example.gov.cn' } } });
    expect(out[1].card).toMatchObject({ props: { mediaLabel: { kind: 'source', text: '来源：example.gov.cn' } } });
  });
});

describe('编排后复检多样性并修正', () => {
  const ev = (t: string): CardSpec => ({ template: 'evidenceList', props: { title: t, rows: [{ badge: '要点', text: '一行' }] } });
  const pic: Broll = { file: 'broll/a.jpg', kind: 'photo', focal: { x: 0.5, y: 0.5 } };
  it('连用第 3 张转掉；带素材的镜头去卡片时保留素材（不把已放好的 B-roll 丢掉）', () => {
    const title = (t: string): CardSpec => ({ template: 'title', props: { title: t } });
    const shots: Shot[] = [
      { start: 0, end: 5, layout: 'split', card: ev('一') },
      { start: 5, end: 10, layout: 'split', card: ev('二') },
      // 第 3 张 evidenceList 转标题卡会和后面两张标题卡连成 3 张，只能去掉卡片：素材保留
      { start: 10, end: 20, layout: 'split', card: ev('三'), broll: pic },
      { start: 20, end: 25, layout: 'split', card: title('四') },
      { start: 25, end: 30, layout: 'split', card: title('五') },
      { start: 30, end: 100, layout: 'full' },
    ];
    const r = rebalance(sb(shots), 100);
    expect(r.fixes.join('')).toMatch(/连续 3 个镜头/);
    expect(r.storyboard.shots[2]).toEqual({ start: 10, end: 20, layout: 'split', broll: pic });
    expect(r.storyboard.shots.slice(0, 2)).toEqual(shots.slice(0, 2));
    expect(storyboardIssues(r.storyboard.shots, 100).filter((i) => /连续/.test(i))).toEqual([]);
  });
  it('没有问题时原样返回', () => {
    const shots: Shot[] = [{ start: 0, end: 5, layout: 'split', card: ev('一') }, { start: 5, end: 30, layout: 'full' }];
    const r = rebalance(sb(shots), 30);
    expect(r.fixes).toEqual([]);
    expect(r.storyboard.shots).toBe(shots);
  });
});

describe('白平衡参考色', () => {
  it('人物背景图整张的平均色（0–1）', async () => {
    const cfg = loadConfig({});
    const file = join(work(), 'bg.png');
    await run(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x336699:s=64x64', '-frames:v', '1', file]);
    const c = await referenceColor(cfg.ffmpeg, file);
    expect(c.r).toBeCloseTo(0x33 / 255, 1);
    expect(c.g).toBeCloseTo(0x66 / 255, 1);
    expect(c.b).toBeCloseTo(0x99 / 255, 1);
  });
});
