// B-roll 编排测试共用的假图库、假模型与素材夹具（真实 ffmpeg 生成的图片与视频，不联网）
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrollDeps } from '../../src/broll/fulfill.js';
import type { NamedSource } from '../../src/broll/gather.js';
import type { Candidate } from '../../src/broll/sources/types.js';
import { loadConfig } from '../../src/config.js';
import type { ChatOptions, LlmClient } from '../../src/llm/kexiang.js';
import { run } from '../../src/media/exec.js';

const cfg = loadConfig({});
/** 假图库里的文件：url → 本地文件 */
const files = new Map<string, { path: string; type: string }>();
let fx = '';

const ff = (args: string[]): Promise<unknown> => run(cfg.ffmpeg, ['-v', 'error', '-y', ...args]);

/** 生成夹具：6 张不同图案的竖图（p0–p5）、1 张 1080p 横图（land）、1 段竖屏视频、截图、生图、钩子图 */
export async function makeBrollFixtures(): Promise<string> {
  if (fx) return fx;
  const dir = mkdtempSync(join(tmpdir(), 'mz-broll-fx-'));
  const patterns = ['testsrc2', 'smptehdbars', 'mandelbrot', 'rgbtestsrc', 'cellauto=rule=110:s=270x480', 'life=s=270x480:mold=10:ratio=0.5'];
  await Promise.all(patterns.map(async (p, i) => {
    const portrait = join(dir, `p${i}.jpg`);
    await ff(['-f', 'lavfi', '-i', p.includes('=') ? p : `${p}=s=1080x1920`, '-vf', 'scale=1080:1920', '-frames:v', '1', portrait]);
    files.set(`https://img.example/p${i}.jpg`, { path: portrait, type: 'image/jpeg' });
    files.set(`https://thumb.example/p${i}.jpg`, { path: portrait, type: 'image/jpeg' });
  }));
  const land = join(dir, 'land.jpg');
  await ff(['-f', 'lavfi', '-i', 'mandelbrot=s=1920x1080', '-frames:v', '1', land]);
  files.set('https://img.example/land.jpg', { path: land, type: 'image/jpeg' });
  files.set('https://thumb.example/land.jpg', { path: land, type: 'image/jpeg' });
  const video = join(dir, 'v.mp4');
  await ff(['-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);
  files.set('https://vid.example/v.mp4', { path: video, type: 'video/mp4' });
  await ff(['-f', 'lavfi', '-i', 'testsrc=s=1080x1920', '-frames:v', '1', join(dir, 'shot.png')]);
  await ff(['-f', 'lavfi', '-i', 'yuvtestsrc=s=1152x2048', '-frames:v', '1', join(dir, 'gen.jpg')]);
  await ff(['-f', 'lavfi', '-i', 'pal75bars=s=1024x1024', '-frames:v', '1', join(dir, 'hook.jpg')]);
  fx = dir;
  return dir;
}

export const fakeFetch: typeof fetch = (async (input: Parameters<typeof fetch>[0]) => {
  const f = files.get(String(input));
  if (!f) return new Response('not found', { status: 404 });
  return new Response(readFileSync(f.path), { status: 200, headers: { 'content-type': f.type } });
}) as typeof fetch;

export const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id: `wikimedia:${id}`, source: 'wikimedia', kind: 'photo', thumb: `https://thumb.example/${id}.jpg`, url: `https://img.example/${id}.jpg`, width: 1080, height: 1920,
  page: `https://commons.wikimedia.org/wiki/File:${id}.jpg`, author: `作者${id}`, license: 'CC BY 4.0', attributionRequired: true, aiGenerated: false, ...over,
});
export const POOL = (): Candidate[] => [cand('p0'), cand('p1'), cand('p2'), cand('p3'), cand('p4'), cand('p5')];
export const wiki = (items: () => Candidate[] | Error, calls?: string[]): NamedSource => ({
  name: 'wikimedia', search: async (q) => { calls?.push(q.text); const r = items(); if (r instanceof Error) throw r; return r; },
});

export interface BrollCalls { image: string[]; screenshot: string[]; search: string[]; video: string[] }
/** 假素材依赖（须先 makeBrollFixtures）：截图、生图、图生视频都拷夹具文件；搜索固定返回一个社区网址 */
export function fakeBrollDeps(sources: NamedSource[], over: Partial<BrollDeps> = {}): { deps: BrollDeps; calls: BrollCalls } {
  const calls: BrollCalls = { image: [], screenshot: [], search: [], video: [] };
  const deps: BrollDeps = {
    screenshot: async (url, out) => { calls.screenshot.push(url); copyFileSync(join(fx, 'shot.png'), out); },
    search: async (q) => { calls.search.push(q); return ['https://minzhi.example.org/community']; },
    image: async (prompt, out) => { calls.image.push(prompt); copyFileSync(join(fx, prompt.includes('HOOK') ? 'hook.jpg' : 'gen.jpg'), out); return { cost: 0.2, url: 'https://gen.example/x.jpg' }; },
    video: async (prompt, _u, out) => { calls.video.push(prompt); copyFileSync(join(fx, 'v.mp4'), out); return { cost: 2.4 }; },
    sources, fetchImpl: fakeFetch, ...over,
  };
  return { deps, calls };
}

export const beatJson = (start: number, end: number, present: string, kind = 'photo', over: Record<string, unknown> = {}) => ({
  start, end, role: 'illustrate', kind, subject: `画面 ${start}`, mustShow: [], avoid: [], queryEn: [`query ${start}`], queryZh: [`查询 ${start}`], present, shotSize: start % 2 ? 'CU' : 'MS', motion: 'static', ...over,
});

/** 视觉节拍、补缺口、审片（序号越小分越高）、主体定位这几种调用的假回答；其余交给 fallback */
export function brollAnswers(beats: unknown, opts: { score?: (o: ChatOptions) => unknown; fallback?: LlmClient } = {}): LlmClient & { labels: string[] } {
  const labels: string[] = [];
  return {
    labels,
    chatJson: async (o) => {
      labels.push(o.label ?? '');
      if (o.label === '视觉节拍') return beats;
      if (o.label === 'B-roll 补真实画面') return { beats: [] };
      if (o.label === 'B-roll 主体定位') return { focal: { x: 0.5, y: 0.4 } };
      if (o.label === 'B-roll 审片打分') {
        if (opts.score) return opts.score(o);
        const n = Number(/共 (\d+) 格/.exec(o.user)?.[1] ?? 0);
        return { scores: Array.from({ length: n }, (_, i) => ({ index: i + 1, relevance: 9 - i * 0.1, aesthetic: 8, brand: 8, clean: 9, tech: 9, note: 'ok' })) };
      }
      if (opts.fallback) return opts.fallback.chatJson(o);
      throw new Error(`没想到的调用：${o.label}`);
    },
  };
}
