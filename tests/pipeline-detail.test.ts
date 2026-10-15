import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import type { Token, Transcript } from '../src/asr/types.js';
import type { Cut } from '../src/cut/llm-cuts.js';
import type { Storyboard } from '../src/storyboard/schema.js';
import type { CardQaEntry } from '../src/qa/visual.js';
import type { ProjectFile } from '../src/pipeline/project.js';
import { cardsDetail, detailOfStep, cardScoreDetail, costDetail, cutsDetail, hardDetail, progressDetail, shotsDetail, transcriptDetail } from '../src/pipeline/detail.js';
import { runPipeline, throttledMatteProgress, throttledRenderProgress, type ProgressEvent } from '../src/pipeline/run.js';
import { hasModels } from './helpers/models.js';

const tok = (text: string, start: number, end: number): Token => ({ text, start, end });
const TOKENS: Token[] = [tok('大', 0, 0.2), tok('家', 0.2, 0.4), tok('好', 0.4, 0.6), tok('嗯', 1.0, 1.2), tok('今', 2.0, 2.2), tok('天', 2.2, 2.4)];

describe('进度明细', () => {
  it('transcript：按语音段分行，给出每行的起止与文本', () => {
    const t: Transcript = { durationSec: 3, segments: [{ start: 0, end: 1.3 }, { start: 1.9, end: 2.5 }], tokens: TOKENS };
    expect(transcriptDetail(t)).toEqual({ kind: 'transcript', data: { lines: [{ start: 0, end: 1.2, text: '大家好嗯' }, { start: 2.0, end: 2.4, text: '今天' }] } });
  });

  it('transcript：没有语音段信息时整段作为一行；超长行按字数切开', () => {
    const many = Array.from({ length: 70 }, (_, i) => tok('字', i * 0.1, i * 0.1 + 0.1));
    const lines = (transcriptDetail({ durationSec: 7, segments: [], tokens: many }).data as { lines: { text: string }[] }).lines;
    expect(lines.map((l) => l.text.length)).toEqual([30, 30, 10]);
  });

  it('cut：带上起止时间、被剪文本、类型与原因', () => {
    const cuts: Cut[] = [{ from: 3, to: 3, type: 'filler', reason: '语气词' }];
    expect(cutsDetail(cuts, TOKENS)).toEqual({ kind: 'cut', data: { cuts: [{ from: 3, to: 3, start: 1.0, end: 1.2, text: '嗯', type: 'filler', reason: '语气词' }] } });
  });

  it('shot：序号、起止、版式、模板名与标题；没有卡片的镜头只有版式', () => {
    const sb: Storyboard = { shots: [
      { start: 0, end: 3, layout: 'split', card: { template: 'title', props: { title: '开场' } } },
      { start: 3, end: 6, layout: 'full' },
      { start: 6, end: 9, layout: 'split', card: { template: 'bigNumber', props: { value: '90', unit: '%', label: '省时' } } },
    ] };
    expect(shotsDetail(sb)).toEqual({ kind: 'shot', data: { shots: [
      { index: 0, start: 0, end: 3, layout: 'split', template: 'title', title: '开场' },
      { index: 1, start: 3, end: 6, layout: 'full' },
      { index: 2, start: 6, end: 9, layout: 'split', template: 'bigNumber', title: '90% 省时' },
    ] } });
  });

  it('qa：单次打分、卡片汇总（取最后一次分数）与成片硬检查', () => {
    const score = { layout: 8, hierarchy: 9, motion: 8, brand: 9, notes: '' };
    expect(cardScoreDetail(2, score, true)).toEqual({ kind: 'qa', data: { phase: 'score', shotIndex: 2, score: { layout: 8, hierarchy: 9, motion: 8, brand: 9 }, passed: true } });
    const report: CardQaEntry[] = [{ shotIndex: 0, scores: [{ ...score, layout: 5 }, score], revised: 1, passed: true }, { shotIndex: 3, scores: [], revised: 0, passed: false, skipped: '预算不足' }];
    expect(cardsDetail(report)).toEqual({ kind: 'qa', data: { phase: 'cards', cards: [
      { shotIndex: 0, score: { layout: 8, hierarchy: 9, motion: 8, brand: 9 }, revised: 1, passed: true },
      { shotIndex: 3, revised: 0, passed: false, skipped: '预算不足' },
    ] } });
    expect(hardDetail([{ id: 'fps', ok: true, detail: '30 fps' }, { id: 'loudness', ok: false, detail: '-20' }])).toEqual({ kind: 'qa', data: { phase: 'hard', ok: false, checks: [{ id: 'fps', ok: true, detail: '30 fps' }, { id: 'loudness', ok: false, detail: '-20' }] } });
  });

  it('cost 与 progress', () => {
    expect(costDetail(1.5, 10)).toEqual({ kind: 'cost', data: { total: 1.5, budget: 10 } });
    expect(costDetail(0, null)).toEqual({ kind: 'cost', data: { total: 0, budget: null } });
    expect(progressDetail('matte', 50, { done: 5, total: 10 })).toEqual({ kind: 'progress', data: { stage: 'matte', pct: 50, done: 5, total: 10 } });
  });

  it('detailOfStep：按步骤从 patch 取明细，其他步骤与空结果返回 undefined', () => {
    const transcript: Transcript = { durationSec: 3, segments: [], tokens: TOKENS };
    const project = { transcript } as ProjectFile;
    expect(detailOfStep('asr', { transcript }, project)?.kind).toBe('transcript');
    expect(detailOfStep('cuts', { cuts: [{ from: 3, to: 3, type: 'filler', reason: '' }] }, project)?.kind).toBe('cut');
    expect(detailOfStep('storyboard', { storyboard: { shots: [] } }, project)?.kind).toBe('shot');
    expect(detailOfStep('qa-cards', { qa: { cards: [{ shotIndex: 0, scores: [], revised: 0, passed: false }], hard: [] } }, project)?.kind).toBe('qa');
    expect(detailOfStep('qa-cards', { qa: { cards: [], hard: [] } }, project)).toBeUndefined();
    expect(detailOfStep('qa-final', { qa: { cards: [], hard: [{ id: 'fps', ok: true, detail: '30' }] } }, project)?.kind).toBe('qa');
    expect(detailOfStep('plan', {}, project)).toBeUndefined();
  });

  it('节流进度回调带上 progress 明细，消息文本不变', () => {
    const events: ProgressEvent[] = [];
    const matte = throttledMatteProgress((e) => events.push(e));
    matte(5, 10);
    const render = throttledRenderProgress((e) => events.push(e));
    render(0.5);
    expect(events).toEqual([
      { step: 'matte', message: '抠像 5/10 帧', detail: { kind: 'progress', data: { stage: 'matte', pct: 50, done: 5, total: 10 } } },
      { step: 'compose', message: '渲染 50%', detail: { kind: 'progress', data: { stage: 'compose', pct: 50 } } },
    ]);
  });
});

const cfg = loadConfig({});
const llm: LlmClient = { chatJson: async () => ({ cuts: [] }) };

describe('runPipeline 取消', () => {
  it('开始前就已取消：不做任何事，直接抛「已取消」', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: ProgressEvent[] = [];
    const workDir = mkdtempSync(join(tmpdir(), 'mz-cancel-'));
    await expect(runPipeline({ input: 'tests/fixtures/talk.mp4', workDir, output: join(workDir, 'out.mp4'), cfg, llm, signal: controller.signal, onProgress: (e) => events.push(e) })).rejects.toThrow('已取消');
    expect(events).toEqual([]);
  });
});

describe.skipIf(!hasModels())('runPipeline 明细事件（需要本地模型）', () => {
  it('识别完成事件带 transcript 明细；在步骤之间取消后不再进入下一步', async () => {
    const controller = new AbortController();
    const events: ProgressEvent[] = [];
    const workDir = mkdtempSync(join(tmpdir(), 'mz-cancel-'));
    await expect(runPipeline({
      input: 'tests/fixtures/talk.mp4', workDir, output: join(workDir, 'out.mp4'), cfg, llm, signal: controller.signal,
      onProgress: (e) => { events.push(e); if (e.step === 'asr') controller.abort(); },
    })).rejects.toThrow('已取消');
    const asr = events.find((e) => e.step === 'asr');
    expect(asr?.detail?.kind).toBe('transcript');
    expect((asr?.detail?.data as { lines: unknown[] }).lines.length).toBeGreaterThan(0);
    expect(events.map((e) => e.step)).not.toContain('cuts');
  });
});
