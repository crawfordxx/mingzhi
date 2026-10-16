import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import { personTransform } from '../src/compose/layout.js';
import { FACE_NOISE_MAX_RATIO, faceNoiseRatio, faceRect, faceSamples, laplacianEnergy } from '../src/qa/face-noise.js';
import { measureFaceNoise } from '../src/qa/face-noise-measure.js';
import { faceNoiseMetric } from '../src/qa/film.js';
import { CANVAS, type Shot } from '../src/storyboard/schema.js';

const cfg = loadConfig({});
const SUBJECT = { top: 0.1, bottom: 1, left: 0.3, right: 0.7 };
const shot = (start: number, end: number, layout: Shot['layout'], extra: Partial<Shot> = {}): Shot => ({ start, end, layout, ...extra }) as Shot;

describe('拉普拉斯能量', () => {
  it('平坦与平滑渐变接近 0，白噪声约为 20σ²，与亮度偏移无关', () => {
    const w = 64, h = 64;
    expect(laplacianEnergy(new Uint8Array(w * h).fill(120), w, h)).toBe(0);
    const ramp = new Uint8Array(w * h).map((_, i) => 60 + (i % w));
    expect(laplacianEnergy(ramp, w, h)).toBe(0);
    let seed = 7;
    const rand = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const noisy = new Uint8Array(w * h).map(() => 128 + (rand() - 0.5) * 20); // 均匀分布 σ = 20/√12 ≈ 5.77
    expect(laplacianEnergy(noisy, w, h)).toBeGreaterThan(20 * 5.77 ** 2 * 0.85);
    expect(laplacianEnergy(noisy, w, h)).toBeLessThan(20 * 5.77 ** 2 * 1.15);
  });
});

describe('人脸区域与取样点', () => {
  it('全屏：人脸区域落在人物框上部中间，且在画布内、偶数对齐', () => {
    const t = personTransform('full', SUBJECT, 1280, 720);
    const r = faceRect(t, SUBJECT, 1280, 720)!;
    expect(r).not.toBeNull();
    expect([r.x % 2, r.y % 2, r.w % 2, r.h % 2]).toEqual([0, 0, 0, 0]);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(CANVAS.width);
    expect(r.y + r.h).toBeLessThanOrEqual(CANVAS.height);
    const top = t.y + SUBJECT.top * 720 * t.scale;
    expect(r.y).toBeGreaterThan(top);
    expect(r.y + r.h).toBeLessThan(top + 0.3 * (SUBJECT.bottom - SUBJECT.top) * 720 * t.scale);
  });

  it('分屏：人脸区域在分界线以下', () => {
    const r = faceRect(personTransform('split', SUBJECT, 1280, 720), SUBJECT, 1280, 720)!;
    expect(r.y).toBeGreaterThan(CANVAS.seam);
  });

  it('只在人物全屏与分屏的镜头取样，过渡之后取点，最多 4 个；没有人物框不取样', () => {
    const shots = [
      shot(0, 3, 'broll', { broll: { file: 'b.jpg', kind: 'photo', focal: { x: 0.5, y: 0.5 } } } as Partial<Shot>),
      shot(3, 6, 'split'), shot(6, 9, 'full'), shot(9, 12, 'split'), shot(12, 15, 'full'), shot(15, 18, 'split'), shot(18, 18.5, 'full'),
    ];
    const s = faceSamples(shots, SUBJECT, 1280, 720);
    expect(s.length).toBe(4);
    for (const x of s) {
      const sh = shots[x.shotIndex];
      expect(['split', 'full']).toContain(sh.layout);
      expect(x.time).toBeGreaterThan(sh.start + 0.5);
      expect(x.time).toBeLessThan(sh.end);
    }
    expect(faceSamples(shots, null, 1280, 720)).toEqual([]);
    // 人物全屏但带卡片（如 CTA 按钮压在头部上方）的镜头不取
    const cta = shot(0, 4, 'full', { card: { template: 'cta', props: { actions: ['关注'] } } } as Partial<Shot>);
    expect(faceSamples([cta], SUBJECT, 1280, 720)).toEqual([]);
    expect(faceSamples([shots[0]], SUBJECT, 1280, 720)).toEqual([]);
  });
});

describe('比值与指标', () => {
  it('比值 = 成片能量合计 / 基准能量合计；基准有下限，极平坦的基准不放大比值', () => {
    expect(faceNoiseRatio([{ time: 1, film: 30, base: 10 }, { time: 2, film: 10, base: 10 }])).toBeCloseTo(2, 5);
    expect(faceNoiseRatio([{ time: 1, film: 1, base: 0 }])).toBeCloseTo(0.5, 5);
    expect(faceNoiseRatio([])).toBe(0);
  });

  it('指标：不超过阈值达标，超过则定位到取样所在的镜头', () => {
    const ok = faceNoiseMetric({ ratio: 1.2, energies: [{ time: 4, film: 12, base: 10 }], samples: 1 }, [shot(0, 3, 'full'), shot(3, 6, 'split')]);
    expect(ok.ok).toBe(true);
    expect(ok.id).toBe('faceNoise');
    expect(ok.limit).toBe(FACE_NOISE_MAX_RATIO);
    const bad = faceNoiseMetric({ ratio: 6.4, energies: [{ time: 4, film: 64, base: 10 }], samples: 1 }, [shot(0, 3, 'full'), shot(3, 6, 'split')]);
    expect(bad.ok).toBe(false);
    expect(bad.shots).toEqual([1]);
    expect(bad.detail).toContain('6.4');
  });
});

describe('measureFaceNoise（真实 ffmpeg）', () => {
  let dir: string;
  const person = (): string => join(dir, 'person.mp4');
  const film = (name: string): string => join(dir, name);
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mz-face-noise-'));
    // 平滑渐变的 640×360 人像（皮肤一样平坦，噪声最容易暴露）
    await run(cfg.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'gradients=s=640x360:d=3:r=30:speed=0.0001:c0=0xb08060:c1=0xc89878:x0=0:y0=0:x1=640:y1=360', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', person()]);
    // 成片：按全屏版式把人像铺到 1080×1920（缩放 + 裁切，与渲染一致），可加亮度噪声
    const t = personTransform('full', SUBJECT, 640, 360);
    const fit = `scale=${Math.round(640 * t.scale)}:${Math.round(360 * t.scale)}:flags=bilinear,crop=1080:1920:${-Math.round(t.x)}:${-Math.round(t.y)}`;
    await run(cfg.ffmpeg, ['-y', '-i', person(), '-vf', fit, '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', film('clean.mp4')]);
    await run(cfg.ffmpeg, ['-y', '-i', person(), '-vf', `${fit},noise=c0s=14:c0f=u+t`, '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', film('noisy.mp4')]);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const opts = (video: string): Parameters<typeof measureFaceNoise>[0] => ({
    ffmpeg: cfg.ffmpeg, video, person: { file: person(), width: 640, height: 360, subject: SUBJECT }, shots: [shot(0, 3, 'full')],
  });

  it('没有颗粒的成片：比值接近 1；加了亮度噪声：比值远超阈值', async () => {
    const clean = await measureFaceNoise(opts(film('clean.mp4')));
    const noisy = await measureFaceNoise(opts(film('noisy.mp4')));
    expect(clean).not.toBeNull();
    expect(clean!.ratio).toBeLessThan(FACE_NOISE_MAX_RATIO);
    expect(noisy!.ratio).toBeGreaterThan(FACE_NOISE_MAX_RATIO * 3);
  }, 60_000);

  it('没有人物框：不检查（返回 null）', async () => {
    expect(await measureFaceNoise({ ...opts(film('clean.mp4')), person: { file: person(), width: 640, height: 360, subject: null } })).toBeNull();
  });
});
