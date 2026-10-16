// 封面失败（含可想 AI 余额不足）不影响成片交付：成片已写完时提示路径与补跑办法；--cover-only 只补封面；工作台版本状态 done + 封面缺失警告
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { CostMeter } from '../src/cost/meter.js';
import { FALLBACK_PRICES } from '../src/cost/prices.js';
import { InsufficientBalanceError } from '../src/llm/errors.js';
import { CancelledError } from '../src/cancel.js';
import { runCover, type CoverDeps } from '../src/pipeline/finish-step.js';
import { runCoverOnly, coverOnlyEstimate } from '../src/pipeline/cover-only.js';
import { EXIT_COVER_MISSING, doneReport, exitCodeOf } from '../src/cli-report.js';
import { projectRecorder, type ProjectFile, type ProjectPatch } from '../src/pipeline/project.js';
import type { EditOp } from '../src/edit/plan.js';
import type { Storyboard } from '../src/storyboard/schema.js';
import { FINAL_FILE, runFirstVersion, runNextVersion } from '../src/workspace/runner.js';
import { makeFixture } from './helpers/runner-fakes.js';

const cfg = loadConfig({});
const llm = { chatJson: async () => ({}) };
const sb: Storyboard = { bgm: 'tech', shots: [{ start: 0, end: 4, layout: 'split', card: { template: 'title', props: { title: '开场' } } }], coverTitle: { title: '三个小习惯' } };
const caps = [{ start: 0, end: 2, text: '开场' }];
const broke: CoverDeps = { makeCovers: async () => { throw new InsufficientBalanceError(); } };

const record = () => {
  const events: { step: string; message: string; patch?: ProjectPatch }[] = [];
  return { events, complete: (step: 'loudness' | 'cover', message: string, patch?: ProjectPatch): ProjectFile => { events.push({ step, message, patch }); return {} as ProjectFile; } };
};

describe('runCover：封面失败不外抛，原因在返回值里', () => {
  it('可想 AI 余额不足：不抛错，返回原因，进度写「封面未生成」，project 记 coverError', async () => {
    const r = record();
    const res = await runCover({ workDir: '/tmp/w', cfg, llm, coverDeps: broke }, undefined, sb, caps, 'x', r.complete);
    expect(res).toEqual({ missing: '可想 AI 账户余额不足，请充值后重试' });
    const last = r.events.at(-1);
    expect(last?.message).toMatch(/^封面未生成：可想 AI 账户余额不足.*成片已完成/);
    expect(last?.patch).toEqual({ coverError: '可想 AI 账户余额不足，请充值后重试' });
  });

  it('其他失败、预算不足同样返回原因；关闭封面与生成成功返回空', async () => {
    const meter = new CostMeter(FALLBACK_PRICES, 0.5);
    expect((await runCover({ workDir: '/tmp/w', cfg, llm, meter, coverDeps: broke }, undefined, sb, caps, 'x', record().complete)).missing).toMatch(/预算不足/);
    expect((await runCover({ workDir: '/tmp/w', cfg, llm, coverDeps: { makeCovers: async () => { throw new Error('生图超时'); } } }, undefined, sb, caps, 'x', record().complete)).missing).toBe('生图超时');
    expect(await runCover({ workDir: '/tmp/w', cfg, llm, coverDeps: broke }, false, sb, caps, 'x', record().complete)).toEqual({});
    const ok: CoverDeps = { makeCovers: async () => ({ cover34: 'a', cover43: 'b', attempts: 1, costYuan: 1.2, unverified: [], person: true, reused: [] }) };
    const r = record();
    expect(await runCover({ workDir: '/tmp/w', cfg, llm, coverDeps: ok }, undefined, sb, caps, 'x', r.complete)).toEqual({});
    expect(r.events.at(-1)?.patch).toMatchObject({ coverError: undefined, cover: { style: 'bauhaus' } });
  });

  it('取消照常外抛', async () => {
    const cancelled: CoverDeps = { makeCovers: async () => { throw new CancelledError(); } };
    await expect(runCover({ workDir: '/tmp/w', cfg, llm, coverDeps: cancelled }, undefined, sb, caps, 'x', record().complete)).rejects.toBeInstanceOf(CancelledError);
  });

  it('补成功后 project.json 里的 coverError 被清掉', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cv-'));
    const rec = projectRecorder(join(dir, 'project.json'), 'in.mp4');
    rec({ coverError: '余额不足' });
    rec({ coverError: undefined });
    expect(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))).not.toHaveProperty('coverError');
  });
});

describe('CLI 完成提示与退出码', () => {
  const base = { cuts: 2, finalSec: 15.2, shots: 5, secs: 120, spent: 1.35, budget: 10, output: '/o/final.mp4', workDir: '/o/work', qaText: '卡片自检 3 张：通过 2、重写 2 次、跳过 0\n成片硬检查：全部通过（8/8）\n整片自检 7/8 达标' };

  it('封面生成了：只有完成提示，退出码 0，没有警告', () => {
    const r = doneReport(base);
    expect(r.text).toContain('完成：删除 2 处 · 成片 15.2 秒 · 5 个镜头 · 用时 120 秒 · 花费 ¥1.35（上限 ¥10.00）');
    expect(r.text).toContain('成片硬检查：全部通过（8/8）\n整片自检 7/8 达标');
    expect(r.text.trim().endsWith('/o/final.mp4')).toBe(true);
    expect(r.warning).toBeUndefined();
    expect(exitCodeOf(r)).toBe(0);
  });

  it('封面没生成：仍打印完成提示与成片路径；警告写明原因与补封面的命令；退出码约定为 0（成片可用）', () => {
    const r = doneReport({ ...base, coverMissing: '可想 AI 账户余额不足，请充值后重试' });
    expect(r.text.trim().endsWith('/o/final.mp4')).toBe(true);
    expect(r.warning).toBe('封面未生成：可想 AI 账户余额不足，请充值后重试；充值后可用 `pnpm mingzhi edit <口播视频> --cover-only --work /o/work` 只补封面');
    expect(exitCodeOf(r)).toBe(EXIT_COVER_MISSING);
    expect(EXIT_COVER_MISSING).toBe(0);
  });

  it('没做自检时不打印自检行', () => {
    expect(doneReport({ ...base, qaText: undefined }).text).not.toContain('自检');
  });

  it('--cover-only 补不成功退出码为 1（那是这次运行唯一要做的事）', () => {
    expect(exitCodeOf(doneReport({ ...base, coverMissing: '余额不足' }), { coverOnly: true })).toBe(1);
    expect(exitCodeOf(doneReport(base), { coverOnly: true })).toBe(0);
  });
});

/** 一个已经出过片、只缺封面的工作目录（成片、人像视频、project.json 都在） */
function finishedWorkDir(): { workDir: string; output: string } {
  const workDir = mkdtempSync(join(tmpdir(), 'mz-coveronly-'));
  const output = join(workDir, 'final.mp4');
  writeFileSync(output, 'film');
  writeFileSync(join(workDir, 'person.mp4'), 'person');
  writeFileSync(join(workDir, 'cut.mp4'), 'cut');
  const project: ProjectFile = {
    version: 1, input: '/in/talk.mp4', createdAt: '2026-10-16T00:00:00.000Z', storyboard: sb, captions: caps,
    qa: { cards: [], hard: [{ id: 'fps', ok: true, detail: '30 fps' }] },
    film: { before: { ok: true, durationSec: 4, metrics: [], templates: [], skipped: [] }, actions: [], unfixed: [] },
    coverError: '可想 AI 账户余额不足，请充值后重试',
    costs: { total: 1.35, budget: 10, entries: [{ kind: 'task', model: 'img', label: '生图', yuan: 1.35 }] },
    artifacts: { final: output, output, person: join(workDir, 'person.mp4'), cut: join(workDir, 'cut.mp4') },
  };
  writeFileSync(join(workDir, 'project.json'), JSON.stringify(project));
  return { workDir, output };
}
const readProject = (workDir: string): ProjectFile => JSON.parse(readFileSync(join(workDir, 'project.json'), 'utf8')) as ProjectFile;

describe('--cover-only：复用工作目录里的成片与分镜，只跑封面', () => {
  const okCovers = (seen: { personVideo?: string; title?: string }[]): CoverDeps => ({
    makeCovers: async (o) => {
      seen.push({ personVideo: o.personVideo, title: o.title });
      const cover34 = join(o.workDir, 'cover-3x4.png');
      const cover43 = join(o.workDir, 'cover-4x3.png');
      writeFileSync(cover34, 'c34');
      writeFileSync(cover43, 'c43');
      o.meter?.addTask('cover', 1.2, '封面');
      return { cover34, cover43, attempts: 2, costYuan: 1.2, unverified: [], person: true, reused: [] };
    },
  });
  const args = (workDir: string, output: string, coverDeps: CoverDeps, meter = new CostMeter(FALLBACK_PRICES, 10)) =>
    ({ workDir, output, cfg, llm, meter, cover: { style: 'bauhaus' as const }, coverDeps });

  it('用工程里的分镜标题与人像视频出封面；project.json 保留原有字段，补上封面、清掉 coverError，账目累加', async () => {
    const { workDir, output } = finishedWorkDir();
    const seen: { personVideo?: string; title?: string }[] = [];
    const res = await runCoverOnly(args(workDir, output, okCovers(seen)));
    expect(res).toEqual({});
    expect(seen).toEqual([{ personVideo: join(workDir, 'person.mp4'), title: '三个小习惯' }]);
    const p = readProject(workDir);
    expect(p).not.toHaveProperty('coverError');
    expect(p.cover).toMatchObject({ style: 'bauhaus', costYuan: 1.2 });
    expect(p.artifacts).toMatchObject({ final: output, cover34: join(workDir, 'cover-3x4.png'), cover43: join(workDir, 'cover-4x3.png') });
    expect(p.qa?.hard).toHaveLength(1);
    expect(p.film).toBeDefined();
    expect(p.storyboard).toEqual(sb);
    expect(p.costs?.total).toBeCloseTo(2.55, 4);
    expect(p.costs?.entries).toHaveLength(2);
    expect(readFileSync(output, 'utf8')).toBe('film');
  });

  it('项目累计花费加上封面会超过上限：不生成、不花钱，返回原因并记 coverError，成片不动', async () => {
    const { workDir, output } = finishedWorkDir();
    const p = readProject(workDir);
    writeFileSync(join(workDir, 'project.json'), JSON.stringify({ ...p, costs: { ...p.costs!, total: 9.2 } }));
    const seen: { personVideo?: string; title?: string }[] = [];
    const res = await runCoverOnly(args(workDir, output, okCovers(seen)));
    expect(res.missing).toMatch(/累计已花 ¥9\.20.*超过上限 ¥10\.00/);
    expect(seen).toEqual([]);
    expect(readProject(workDir).coverError).toMatch(/累计已花/);
    expect(readProject(workDir).costs?.total).toBeCloseTo(9.2, 4);
    expect(readFileSync(output, 'utf8')).toBe('film');
  });

  it('没有人像视频（没换背景）时用剪切结果；封面又失败（余额不足）：不抛错，返回原因，coverError 保留，成片不动', async () => {
    const { workDir, output } = finishedWorkDir();
    const p = readProject(workDir);
    writeFileSync(join(workDir, 'project.json'), JSON.stringify({ ...p, artifacts: { final: output, output, cut: join(workDir, 'cut.mp4') } }));
    const seen: { personVideo?: string }[] = [];
    const used: CoverDeps = { makeCovers: async (o) => { seen.push({ personVideo: o.personVideo }); throw new InsufficientBalanceError(); } };
    const res = await runCoverOnly(args(workDir, output, used));
    expect(res.missing).toMatch(/余额不足/);
    expect(seen[0].personVideo).toBe(join(workDir, 'cut.mp4'));
    expect(readProject(workDir).coverError).toMatch(/余额不足/);
    expect(readFileSync(output, 'utf8')).toBe('film');
  });

  it('工作目录里没有 project.json、没有分镜或成片：报清楚的错，不花钱', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mz-empty-'));
    await expect(runCoverOnly(args(empty, join(empty, 'x.mp4'), broke))).rejects.toThrow(/没有 project\.json.*先完整跑一遍/);
    const { workDir, output } = finishedWorkDir();
    const p = readProject(workDir);
    const { storyboard: _s, ...noBoard } = p;
    writeFileSync(join(workDir, 'project.json'), JSON.stringify(noBoard));
    await expect(runCoverOnly(args(workDir, output, broke))).rejects.toThrow(/没有分镜/);
    writeFileSync(join(workDir, 'project.json'), JSON.stringify({ ...p, artifacts: { ...p.artifacts, final: join(workDir, 'gone.mp4'), output: join(workDir, 'gone.mp4') } }));
    await expect(runCoverOnly(args(workDir, output, broke))).rejects.toThrow(/成片.*不存在/);
  });

  it('预估只含封面', () => {
    const e = coverOnlyEstimate();
    expect(e.items.map((i) => i.label)).toEqual(['封面']);
    expect(e.high).toBeGreaterThan(e.low);
  });
});

describe('工作台：封面失败的版本照常 done，带封面缺失警告', () => {
  it('首个版本封面余额不足：版本状态 done，成片在，没有封面文件，meta.warnings 写明原因，事件里有「封面未生成」', async () => {
    const f = makeFixture();
    f.ctx.coverDeps = broke;
    const meta = await runFirstVersion(f.ctx, f.spaceId);
    const dir = f.store.versionDir(f.spaceId, 1);
    expect(meta.status).toBe('done');
    expect(meta.warnings).toEqual(['封面未生成：可想 AI 账户余额不足，请充值后重试']);
    expect(existsSync(join(dir, FINAL_FILE))).toBe(true);
    expect(existsSync(join(dir, 'cover-3x4.png'))).toBe(false);
    expect(readProject(dir)).toMatchObject({ coverError: '可想 AI 账户余额不足，请充值后重试' });
    expect(f.events.some((e) => e.step === 'cover' && e.message.startsWith('封面未生成'))).toBe(true);
    expect(f.events.at(-1)?.step).toBe('done');
    expect(f.store.get(f.spaceId).versions[0].status).toBe('done');
  });

  it('封面成功的版本没有 warnings；后续修改版本沿用父版本的封面缺失警告，换封面风格成功后警告消失', async () => {
    const f = makeFixture();
    f.ctx.coverDeps = broke;
    await runFirstVersion(f.ctx, f.spaceId);
    const work = await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'setCaptionStyle', id: 'wenkai' } as EditOp], '换字幕样式');
    expect(work.status).toBe('done');
    expect(work.warnings).toEqual(['封面未生成：可想 AI 账户余额不足，请充值后重试']);
    const good = makeFixture();
    const meta = await runFirstVersion(good.ctx, good.spaceId);
    expect(meta.warnings).toBeUndefined();
    expect(readProject(good.store.versionDir(good.spaceId, 1))).not.toHaveProperty('coverError');
  });
});
