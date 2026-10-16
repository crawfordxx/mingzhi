import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { CostMeter } from '../src/cost/meter.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import type { ProjectFile } from '../src/pipeline/project.js';
import { runPipeline, type ProgressEvent } from '../src/pipeline/run.js';
import type { QaDeps } from '../src/pipeline/qa-step.js';
import type { CardQaEntry } from '../src/qa/visual.js';
import type { HardCheck } from '../src/qa/hard.js';
import type { FilmReport } from '../src/qa/film.js';
import type { Storyboard } from '../src/storyboard/schema.js';
import { hasModels } from './helpers/models.js';
import { FAKE_STORYBOARD, fakeQa } from './helpers/pipeline-fakes.js';

// 真实剪切与渲染整条片：放在串行组（vitest.config.ts 的 SERIAL_TESTS）
const CLIP = join(import.meta.dirname, 'fixtures', 'talk.mp4');

describe.skipIf(!hasModels())('runPipeline 自检步骤（需要本地模型）', () => {
  const llm: LlmClient = { chatJson: async (o) => (o.system.includes('分镜') ? FAKE_STORYBOARD : o.system.includes('剪辑师') ? { cuts: [] } : { lines: [] }) };
  const cfg = { ...loadConfig({}), dataDir: mkdtempSync(join(tmpdir(), 'mz-empty-')) };
  const failing: HardCheck = { id: 'loudness', ok: false, detail: '积分响度 -20.0 LUFS（要求 -14 ± 1）' };

  it('自检改写的分镜用于成片并写进 project.json；未传 meter 时用不限预算的账；硬检查未通过只报告不报错', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-qa-'));
    const revisedCard = { template: 'title' as const, props: { title: '重写后' } };
    const report: CardQaEntry[] = [{ shotIndex: 0, scores: [], revised: 1, passed: true }];
    const rendered: unknown[] = [];
    const { deps, seen } = fakeQa(report);
    const qaDeps: QaDeps = {
      qaCards: async (o) => { await deps.qaCards!(o); return { storyboard: { ...o.storyboard, shots: o.storyboard.shots.map((s) => ({ ...s, card: revisedCard })) }, report }; },
      film: deps.film,
      hardChecks: async (video) => { rendered.push(existsSync(video)); return [failing, { id: 'fps', ok: true, detail: '30 fps' }]; },
    };
    const events: ProgressEvent[] = [];
    const res = await runPipeline({ input: CLIP, workDir, output: join(workDir, 'out.mp4'), cfg, llm, cover: false, qaDeps, onProgress: (e) => events.push(e) });
    expect(res.storyboard.shots[0].card).toEqual(revisedCard);
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8')) as ProjectFile;
    expect(project.storyboard?.shots[0].card).toEqual(revisedCard);
    expect(project.qa).toEqual({ cards: report, hard: [failing, { id: 'fps', ok: true, detail: '30 fps' }] });
    expect(res.qa).toEqual(project.qa);
    expect(seen[0].meter).toMatchObject({ total: 0, budget: Number.POSITIVE_INFINITY });
    expect(rendered).toEqual([true]);
    expect(events.find((e) => e.step === 'qa-cards')?.message).toBe('卡片自检 1 张：通过 1、重写 1 次、跳过 0');
    expect(events.find((e) => e.step === 'qa-final')?.message).toBe('成片硬检查 1/2 通过，未通过：loudness（积分响度 -20.0 LUFS（要求 -14 ± 1））');
    expect(events.at(-1)?.step).toBe('done');
  }, 240_000);

  it('传了 meter 就把同一个 meter 交给卡片自检；硬检查自己出错只报进度，流程照常走完', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-qa-'));
    const meter = new CostMeter({}, 7);
    const { deps, seen } = fakeQa();
    const events: ProgressEvent[] = [];
    const res = await runPipeline({ input: CLIP, workDir, output: join(workDir, 'out.mp4'), cfg, llm, cover: false, meter,
      qaDeps: { ...deps, hardChecks: async () => { throw new Error('ffmpeg 崩了'); } }, onProgress: (e) => events.push(e) });
    expect(seen[0].meter).toBe(meter);
    expect(events.find((e) => e.step === 'qa-final')?.message).toBe('成片硬检查失败，已跳过（成片不受影响）：ffmpeg 崩了');
    expect(res.qa.hard).toEqual([]);
    expect(existsSync(res.output)).toBe(true);
  }, 240_000);

  it('整片自检不达标：局部重做只改目标镜头、按新分镜重渲一次、复测；最终分镜用于成片检查并写进 project.json', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-film-'));
    const bad: FilmReport = { ok: false, durationSec: 2, metrics: [{ id: 'blank', label: '上半屏空白率', value: 0.9, limit: 0.8, ok: false, detail: '最高 90%', shots: [0] }], templates: [], skipped: [] };
    const measured: Storyboard[] = [];
    const film: QaDeps['film'] = async (o) => { measured.push(o.storyboard); return measured.length === 1 ? bad : { ...bad, ok: true, metrics: [{ ...bad.metrics[0], ok: true, value: 0.4, shots: [] }] }; };
    const hardSeen: string[] = [];
    const events: ProgressEvent[] = [];
    // 三个镜头：只有第 1 镜要重做，它和紧跟的镜头（交叉淡出）重渲，后面的镜头复用缓存
    const three = { ...FAKE_STORYBOARD, shots: [FAKE_STORYBOARD.shots[0], { start: 2, end: 4, layout: 'full' }, { start: 4, end: 6, layout: 'split', card: { template: 'title', props: { title: '后面' } } }] };
    const llm3: LlmClient = { chatJson: async (o) => (o.system.includes('分镜') ? three : o.system.includes('剪辑师') ? { cuts: [] } : { lines: [] }) };
    const res = await runPipeline({ input: CLIP, workDir, output: join(workDir, 'out.mp4'), cfg, llm: llm3, cover: false,
      qaDeps: { ...fakeQa().deps, film, hardChecks: async (video) => { hardSeen.push(video); return []; } }, onProgress: (e) => events.push(e) });
    expect(measured).toHaveLength(2);
    expect(measured[0].shots[0].layout).toBe('split');
    expect(measured[1].shots[0]).toMatchObject({ layout: 'overlay', card: { template: 'title' } });
    expect(res.storyboard.shots[0].layout).toBe('overlay');
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8')) as ProjectFile;
    expect(project.storyboard?.shots[0].layout).toBe('overlay');
    expect(project.film).toMatchObject({ before: { ok: false }, actions: [{ shotIndex: 0, kind: 'overlay' }], after: { ok: true } });
    expect(events.filter((e) => e.step === 'qa-film').map((e) => e.message).join('\n')).toMatch(/局部重做：第 1 镜：标题卡改浮层[\s\S]*局部重做后：整片自检 1\/1 达标/);
    // 只重渲受影响的分段：其余分段复用缓存
    const redo = events.find((e) => e.step === 'compose' && /^局部重做：重渲 \d+ 段/.test(e.message))?.message ?? '';
    const [, rendered, reused] = /重渲 (\d+) 段 · 复用缓存 (\d+) 段/.exec(redo) ?? [];
    expect(Number(rendered)).toBeGreaterThan(0);
    expect(Number(reused)).toBeGreaterThan(0);
    expect(hardSeen).toEqual([join(workDir, 'out.mp4')]);
  }, 240_000);

  it('qa: false 跳过两个自检步骤，project.json 没有 qa', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-qa-'));
    const qaDeps: QaDeps = { qaCards: async () => { throw new Error('不应自检卡片'); }, hardChecks: async () => { throw new Error('不应检查成片'); } };
    const events: ProgressEvent[] = [];
    const res = await runPipeline({ input: CLIP, workDir, output: join(workDir, 'out.mp4'), cfg, llm, cover: false, qa: false, qaDeps, onProgress: (e) => events.push(e) });
    expect(events.map((e) => e.step)).not.toContain('qa-cards');
    expect(events.map((e) => e.step)).not.toContain('qa-final');
    expect(events.map((e) => e.step)).not.toContain('qa-film');
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8')) as ProjectFile;
    expect(project.qa).toBeUndefined();
    expect(res.qa).toEqual({ cards: [], hard: [] });
  }, 240_000);
});
