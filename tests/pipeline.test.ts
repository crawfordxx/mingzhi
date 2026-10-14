import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { burnSubtitles } from '../src/captions/burn.js';
import { toAss } from '../src/captions/ass.js';
import { loadConfig } from '../src/config.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import { run } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';
import type { ProjectFile } from '../src/pipeline/project.js';
import { runPipeline, type ProgressEvent } from '../src/pipeline/run.js';
import { hasModels } from './helpers/models.js';

describe('burnSubtitles', () => {
  it('工作目录名含 \' , [ ] = ; 等特殊字符时也能烧录', async () => {
    const cfg = loadConfig({});
    const dir = join(mkdtempSync(join(tmpdir(), 'mz-')), "it's 视频,[1] a=b;c");
    mkdirSync(dir);
    const input = join(dir, 'in.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=540x960:r=30:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
    const assPath = join(dir, 'captions.ass');
    writeFileSync(assPath, toAss([{ start: 0, end: 1, text: '测试' }], { width: 540, height: 960 }));
    const output = join(dir, 'out.mp4');
    await burnSubtitles(input, assPath, output, cfg);
    const info = await probe(output, cfg);
    expect([info.width, info.height, info.hasAudio]).toEqual([540, 960, true]);
  });
});

describe.skipIf(!hasModels())('runPipeline（需要本地模型）', () => {
  afterEach(() => vi.restoreAllMocks());

  it('样片：删掉停顿与「嗯」，输出成片、ASS 和 project.json', async () => {
    // 假模型返回的字幕结果非法，会走兜底分行；告警应通过 onProgress 告知，而不是打控制台
    const warn = vi.spyOn(console, 'warn');
    const cfg = loadConfig({});
    const work = mkdtempSync(join(tmpdir(), 'mz-'));
    // 假模型：剪掉文字为「嗯」的 token；字幕返回非法结果以走兜底分行
    const llm: LlmClient = {
      chatJson: async (o) => {
        if (o.system.includes('剪辑师')) {
          const idx = [...o.user.matchAll(/\[(\d+)\]嗯/g)].map((m) => Number(m[1]));
          // 末尾混入一条越界的坏项，应被丢弃并在 cuts 步骤消息里说明
          return { cuts: [...idx.map((i) => ({ from: i, to: i, type: 'filler', reason: '语气词' })), { from: -1, to: 0, type: 'filler' }] };
        }
        return { lines: [] };
      },
    };
    const events: ProgressEvent[] = [];
    // 每一步完成后 project.json 立即落盘：在 plan 步骤回调时读出来，应已有剪切与方案、还没有字幕
    const snapshots: Partial<Record<string, ProjectFile>> = {};
    const onProgress = (e: ProgressEvent): void => {
      events.push(e);
      if (e.step === 'plan') snapshots.plan = JSON.parse(readFileSync(join(work, 'project.json'), 'utf8')) as ProjectFile;
    };
    const input = join(import.meta.dirname, 'fixtures', 'talk.mp4');
    const res = await runPipeline({ input, workDir: work, output: join(work, 'out.mp4'), cfg, llm, onProgress });
    const src = await probe(input, cfg);
    const out = await probe(res.output, cfg);
    expect(out.durationSec).toBeLessThan(src.durationSec - 1.0);
    expect(events.map((e) => e.step)).toEqual(['probe', 'audio', 'asr', 'cuts', 'plan', 'render', 'captions', 'burn', 'done']);
    // 兜底分行按字数换行，「高性价比」可能被拆到相邻两行，所以拼接所有字幕行再断言
    const assText = readFileSync(join(work, 'captions.ass'), 'utf8').split('\n')
      .filter((l) => l.startsWith('Dialogue:')).map((l) => l.split(',').slice(9).join(',')).join('');
    expect(assText).toContain('高性价比');
    expect(res.captions.length).toBeGreaterThan(0);
    expect(snapshots.plan?.plan?.keep.length).toBeGreaterThan(0);
    expect(snapshots.plan?.cuts?.length).toBeGreaterThan(0);
    expect(snapshots.plan?.captions).toBeUndefined();
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8')) as ProjectFile;
    expect(project.version).toBe(1);
    expect(project.transcript?.tokens.length).toBeGreaterThan(20);
    expect(project.captionsSource).toBe('fallback');
    expect(project.captionLines?.length).toBeGreaterThan(0);
    expect(project.captionLines?.[0]).toMatchObject({ from: expect.any(Number), to: expect.any(Number), text: expect.any(String) });
    expect(project.artifacts).toEqual({ wav: join(work, 'audio16k.wav'), cut: join(work, 'cut.mp4'), ass: join(work, 'captions.ass'), output: join(work, 'out.mp4') });
    expect(existsSync(join(work, 'cut.mp4'))).toBe(true);
    expect(events.find((e) => e.step === 'captions')?.message).toContain('改用自动分行');
    expect(events.find((e) => e.step === 'cuts')?.message).toContain('丢弃 1 条');
    expect(warn).not.toHaveBeenCalled();
  }, 120_000);
});
