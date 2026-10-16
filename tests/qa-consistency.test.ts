// 「成片硬检查」与「整片自检」分开打印、各自的通过数与总数来自 project.json 同一数据源：工作台事件、project.json、CLI 完成提示三处一致
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filmSummary, type FilmMetric, type FilmReport } from '../src/qa/film.js';
import { filmFinal, hardSummary, projectQaSummary } from '../src/pipeline/qa-step.js';
import type { ProjectFile } from '../src/pipeline/project.js';
import { runFirstVersion } from '../src/workspace/runner.js';
import { makeFixture } from './helpers/runner-fakes.js';

const metric = (i: number, ok: boolean): FilmMetric => ({ id: i === 7 ? 'coverage' : 'static', label: `指标${i}`, value: 0, limit: 0, ok, detail: `详情${i}`, shots: [] });
/** 整片自检 8 项里有 1 项（摄影级画面覆盖）不达标且只能报告；成片硬检查 3 项全过：两个口径的总数不同 */
const film: FilmReport = { ok: false, durationSec: 12, metrics: Array.from({ length: 8 }, (_, i) => metric(i, i !== 7)), templates: [], skipped: [] };
const hard = [{ id: 'fps' as const, ok: true, detail: '30 fps' }, { id: 'resolution' as const, ok: true, detail: '1080×1920' }, { id: 'loudness' as const, ok: true, detail: '-14 LUFS' }];

describe('自检口径一致', () => {
  it('工作台首版：qa-final / qa-film 事件、project.json、CLI 摘要的通过数与总数相同，且两行各自成行', async () => {
    const f = makeFixture();
    f.ctx.qaDeps = { ...f.ctx.qaDeps, film: async () => film, hardChecks: async () => hard };
    await runFirstVersion(f.ctx, f.spaceId);
    const project = JSON.parse(readFileSync(join(f.store.versionDir(f.spaceId, 1), 'project.json'), 'utf8')) as ProjectFile;
    const lines = projectQaSummary(project).split('\n');
    const hardEvent = f.events.filter((e) => e.step === 'qa-final').at(-1)?.message;
    const filmEvent = f.events.filter((e) => e.step === 'qa-film').at(-1)?.message;
    expect(lines[1]).toBe('成片硬检查：全部通过（3/3）');
    expect(hardEvent).toBe(lines[1]);
    expect(lines[2]).toMatch(/^整片自检 7\/8 达标/);
    expect(filmEvent).toContain(lines[2]);
    expect(lines[2]).toBe(filmSummary(filmFinal(project.film as never)));
    // 不达标的整片自检项没有被「成片硬检查全部通过」盖住，也进了 film.unfixed
    expect(project.film?.unfixed.join('\n')).toMatch(/摄影级画面|指标7/);
    expect(hardSummary(project.qa?.hard ?? [])).toBe(lines[1]);
  });
});
