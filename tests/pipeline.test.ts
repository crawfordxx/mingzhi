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
import { runPipeline } from '../src/pipeline/run.js';
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
    // 假模型返回的字幕结果非法，会触发兜底分行的告警；这里静音并断言它确实发生
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig({});
    const work = mkdtempSync(join(tmpdir(), 'mz-'));
    // 假模型：剪掉文字为「嗯」的 token；字幕返回非法结果以走兜底分行
    const llm: LlmClient = {
      chatJson: async (o) => {
        if (o.system.includes('剪辑师')) {
          const idx = [...o.user.matchAll(/\[(\d+)\]嗯/g)].map((m) => Number(m[1]));
          return { cuts: idx.map((i) => ({ from: i, to: i, type: 'filler', reason: '语气词' })) };
        }
        return { lines: [] };
      },
    };
    const steps: string[] = [];
    const input = join(import.meta.dirname, 'fixtures', 'talk.mp4');
    const res = await runPipeline({ input, workDir: work, output: join(work, 'out.mp4'), cfg, llm, onProgress: (e) => steps.push(e.step) });
    const src = await probe(input, cfg);
    const out = await probe(res.output, cfg);
    expect(out.durationSec).toBeLessThan(src.durationSec - 1.0);
    expect(steps).toEqual(['probe', 'audio', 'asr', 'cuts', 'plan', 'render', 'captions', 'burn', 'done']);
    // 兜底分行按字数换行，「高性价比」可能被拆到相邻两行，所以拼接所有字幕行再断言
    const assText = readFileSync(join(work, 'captions.ass'), 'utf8').split('\n')
      .filter((l) => l.startsWith('Dialogue:')).map((l) => l.split(',').slice(9).join(',')).join('');
    expect(assText).toContain('高性价比');
    expect(res.captions.length).toBeGreaterThan(0);
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8'));
    expect(project.version).toBe(1);
    expect(project.transcript.tokens.length).toBeGreaterThan(20);
    expect(existsSync(join(work, 'cut.mp4'))).toBe(true);
    expect(warn).toHaveBeenCalledWith('字幕校对结果不合法，改用自动分行');
  }, 120_000);
});
