import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Token } from '../src/asr/types.js';
import { polishCaptions } from '../src/captions/polish.js';
import { loadConfig } from '../src/config.js';
import { InsufficientBalanceError } from '../src/llm/errors.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import { runBroll } from '../src/pipeline/broll-step.js';
import { runCover } from '../src/pipeline/finish-step.js';
import type { ProjectFile } from '../src/pipeline/project.js';
import { generateStoryboard } from '../src/storyboard/generate.js';
import type { Storyboard } from '../src/storyboard/schema.js';

const broke = (): never => { throw new InsufficientBalanceError(); };
const brokeLlm: LlmClient = { chatJson: async () => broke() };
const complete = (): ProjectFile => ({}) as ProjectFile;
const caps = [{ start: 0, end: 2.5, text: 'FDE 这个岗位' }, { start: 2.5, end: 5, text: '现在看来基本定性了' }];

describe('余额不足必须直接往外抛，不走降级', () => {
  it('分镜：首次请求与重试请求都不吞掉', async () => {
    await expect(generateStoryboard(brokeLlm, caps, 5, [])).rejects.toBeInstanceOf(InsufficientBalanceError);
    let n = 0;
    const second: LlmClient = { chatJson: async () => { n += 1; return n === 1 ? { shots: [] } : broke(); } };
    await expect(generateStoryboard(second, caps, 5, [])).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it('字幕校对：不退回自动分行', async () => {
    const tokens: Token[] = [...'你好世界'].map((text, i) => ({ text, start: i * 0.2, end: i * 0.2 + 0.2 }));
    await expect(polishCaptions(brokeLlm, tokens, [0, 1, 2, 3])).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it('B-roll：生图遇到余额不足整步抛出，不降级为去掉素材', async () => {
    const storyboard: Storyboard = { shots: [
      { start: 0, end: 5, layout: 'split', card: { template: 'photo', props: { visual: { source: 'generate', prompt: 'a jar' } } } },
      { start: 5, end: 10, layout: 'full' },
    ] };
    const deps = { screenshot: broke, search: async () => [], image: async () => broke(), video: broke };
    const workDir = mkdtempSync(join(tmpdir(), 'mz-bal-'));
    await expect(runBroll({ workDir, cfg: loadConfig({}), broll: { enabled: true, maxVideos: 0, budgetYuan: 10 }, brollDeps: deps }, storyboard, 10, complete)).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it('封面：不降级为一条进度提示', async () => {
    const sb: Storyboard = { bgm: 'tech', shots: [{ start: 0, end: 4, layout: 'full' }] };
    const coverDeps = { makeCovers: async () => broke() };
    await expect(runCover({ workDir: '/tmp/w', cfg: loadConfig({}), llm: brokeLlm, coverDeps }, undefined, sb, caps, 'x', complete)).rejects.toBeInstanceOf(InsufficientBalanceError);
  });
});
