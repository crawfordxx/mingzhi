import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';
import type { TaskClient, TaskInput } from '../src/llm/kexiang-task.js';
import { generateImage, generateVideo, IMAGE_MODEL, searchPexels, VIDEO_MODEL } from '../src/broll/generate-media.js';

const fakeTask = (inputs: TaskInput[], url = 'https://x/r'): TaskClient => ({ run: async (input) => { inputs.push(input); return { taskId: '1', url, cost: 0.2 }; } });

describe('generateImage', () => {
  it('1:1 1k medium jpeg，提示词追加无文字要求，返回花费', async () => {
    const inputs: TaskInput[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'mz-gi-'));
    const res = await generateImage(fakeTask(inputs), 'a jar of coins on a wooden table', join(dir, 'a.jpg'), async (_u, d) => writeFileSync(d, 'x'));
    expect(inputs[0]).toMatchObject({ modelName: IMAGE_MODEL, modelType: 'text2img', size: '1:1', resolution: '1k', quality: 'medium', output_format: 'jpeg' });
    expect(String(inputs[0].prompt)).toContain('no text');
    expect(res.cost).toBe(0.2);
  });

  it('提示词套统一影调模板并带禁用词（中英文）', async () => {
    const inputs: TaskInput[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'mz-gi-'));
    await generateImage(fakeTask(inputs), 'a contract on a desk', join(dir, 'a.jpg'), async (_u, d) => writeFileSync(d, 'x'));
    const prompt = String(inputs[0].prompt);
    expect(prompt.startsWith('a contract on a desk')).toBe(true);
    expect(prompt).toContain('editorial photography, soft window light, warm neutral palette, 50mm, shallow depth of field, matte film look, subtle grain, no text');
    for (const word of ['hologram', 'robot', 'neon', 'glowing', '全息', '机器人', '霓虹', '发光']) expect(prompt).toContain(word);
    expect(prompt).toContain('no watermark');
  });
});

describe('generateVideo', () => {
  it('Seedance Mini 文生视频 1:1 4 秒 720p 无水印无音频；下载后转成 30fps 无音轨', async () => {
    const cfg = loadConfig({});
    const inputs: TaskInput[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'mz-gv-'));
    const dest = join(dir, 'v.mp4');
    const fakeDownload = async (_u: string, d: string) => {
      await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x320:r=24:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', d]);
    };
    await generateVideo(fakeTask(inputs), 'slow push-in on a glass of cola with ice', dest, cfg, fakeDownload);
    expect(inputs[0]).toMatchObject({ modelName: VIDEO_MODEL, modelType: 'text2video', ratio: '1:1', duration: 4, resolution: '720p', watermark: false, generate_audio: false });
    expect(inputs[0].content).toEqual([{ type: 'text', text: 'slow push-in on a glass of cola with ice' }]);
    const info = await probe(dest, cfg);
    expect(info.fps).toBe(30);
    expect(info.hasAudio).toBe(false);
    expect(existsSync(`${dest}.raw.mp4`)).toBe(false);
  });

  it('onStatus 透传给任务客户端，供长任务显示进度', async () => {
    const cfg = loadConfig({});
    const seen: unknown[] = [];
    const task: TaskClient = { run: async (_i, opts) => { seen.push(opts.onStatus); return { taskId: '1', url: 'https://x/r' }; } };
    const onStatus = (): void => undefined;
    const dir = mkdtempSync(join(tmpdir(), 'mz-gv-st-'));
    await generateVideo(task, 'slow push-in on a glass of cola with ice', join(dir, 'v.mp4'), cfg, async (_u, d) => {
      await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x320:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', d]);
    }, onStatus);
    expect(seen).toEqual([onStatus]);
  });

  it('下载到的不是有效视频时转码失败：报中文错误，且清掉 raw 中间文件', async () => {
    const cfg = loadConfig({});
    const dir = mkdtempSync(join(tmpdir(), 'mz-gv-bad-'));
    const dest = join(dir, 'v.mp4');
    await expect(generateVideo(fakeTask([]), 'x', dest, cfg, async (_u, d) => writeFileSync(d, 'not a video'))).rejects.toThrow(/转换.*30fps/);
    expect(existsSync(`${dest}.raw.mp4`)).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });
});

describe('searchPexels', () => {
  it('带 key 搜方图，下载第一张 large2x；没有结果返回 false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-px-'));
    const seen: { url: string; auth?: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      if (url.startsWith('https://api.pexels.com')) return new Response(JSON.stringify({ photos: url.includes('nothing') ? [] : [{ src: { large2x: 'https://images.pexels.com/p.jpg' } }] }));
      return new Response('img');
    }) as unknown as typeof fetch;
    expect(await searchPexels('pk', 'coins jar', join(dir, 'p.jpg'), { fetchImpl })).toBe(true);
    expect(seen[0].url).toContain('query=coins%20jar');
    expect(seen[0].auth).toBe('pk');
    expect(await searchPexels('pk', 'nothing', join(dir, 'q.jpg'), { fetchImpl })).toBe(false);
  });
});
