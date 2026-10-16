// 整片自检局部重做：重渲到临时文件，成功后才覆盖已交付的成片；失败或取消时成片原样保留
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CancelledError } from '../src/cancel.js';
import type { FilmReport } from '../src/qa/film.js';
import type { ProjectFile } from '../src/pipeline/project.js';
import type { MediaDeps } from '../src/pipeline/media-deps.js';
import { FINAL_FILE, runFirstVersion } from '../src/workspace/runner.js';
import { makeFixture, type Fixture } from './helpers/runner-fakes.js';

// 第 1 镜上半屏空白率超标：局部重做把标题卡改浮层（只改这一镜），复测达标
const bad: FilmReport = { ok: false, durationSec: 2, metrics: [{ id: 'blank', label: '上半屏空白率', value: 0.9, limit: 0.8, ok: false, detail: '最高 90%', shots: [0] }], templates: [], skipped: [] };
const good: FilmReport = { ...bad, ok: true, metrics: [{ ...bad.metrics[0], ok: true, value: 0.4, shots: [] }] };

/** 整片度量先不达标再达标；第二次响度统一（重做那次）按 fail 的方式出错 */
function redoFixture(fail?: () => never): { f: Fixture; final: () => string } {
  const f = makeFixture({ broll: false });
  let measured = 0;
  f.ctx.qaDeps = { ...f.ctx.qaDeps, film: async () => (measured++ === 0 ? bad : good) };
  const media = f.ctx.media as Partial<MediaDeps>;
  const loudness = media.loudness!;
  let calls = 0;
  f.ctx.media = { ...media, loudness: async (input, output, cfg) => { calls += 1; if (calls === 2 && fail) fail(); return loudness(input, output, cfg); } };
  return { f, final: () => join(f.store.versionDir(f.spaceId, 1), FINAL_FILE) };
}

const leftovers = (dir: string): string[] => readdirSync(dir).filter((n) => n.includes('.redo'));

describe('局部重做不删已交付的成片', () => {
  it('重做成功：成片换成重做后的版本，project.json 的成片路径仍是 final.mp4，不留临时文件', async () => {
    const { f, final } = redoFixture();
    const meta = await runFirstVersion(f.ctx, f.spaceId);
    expect(meta.status).toBe('done');
    const project = JSON.parse(readFileSync(join(f.store.versionDir(f.spaceId, 1), 'project.json'), 'utf8')) as ProjectFile;
    expect(project.film).toMatchObject({ actions: [{ shotIndex: 0, kind: 'overlay' }], after: { ok: true } });
    expect(project.artifacts).toMatchObject({ output: final(), final: final() });
    expect(existsSync(final())).toBe(true);
    expect(leftovers(f.store.versionDir(f.spaceId, 1))).toEqual([]);
  });

  it('重做时响度统一失败：撤回重做，首版成片仍在且内容不变', async () => {
    const { f, final } = redoFixture(() => { throw new Error('磁盘满了'); });
    const meta = await runFirstVersion(f.ctx, f.spaceId);
    expect(meta.status).toBe('done');
    const project = JSON.parse(readFileSync(join(f.store.versionDir(f.spaceId, 1), 'project.json'), 'utf8')) as ProjectFile;
    expect(project.film?.actions).toEqual([]);
    expect(project.film?.unfixed.join('\n')).toMatch(/局部重做渲染失败，已撤回.*磁盘满了/);
    expect(project.artifacts).toMatchObject({ output: final(), final: final() });
    expect(existsSync(final())).toBe(true);
    expect(JSON.parse(readFileSync(final(), 'utf8'))).toMatchObject({ kind: 'final' });
    expect(f.calls.hard).toEqual([final()]);
    expect(leftovers(f.store.versionDir(f.spaceId, 1))).toEqual([]);
  });

  it('重做时取消：首版成片保留，不留临时文件', async () => {
    const { f, final } = redoFixture(() => { throw new CancelledError(); });
    await runFirstVersion(f.ctx, f.spaceId).catch(() => undefined);
    expect(existsSync(final())).toBe(true);
    expect(leftovers(f.store.versionDir(f.spaceId, 1))).toEqual([]);
  });

  const artifactsOf = (f: Fixture) => (JSON.parse(readFileSync(join(f.store.versionDir(f.spaceId, 1), 'project.json'), 'utf8')) as ProjectFile).artifacts;

  it('重做时片尾校正阶段取消（响度统一已把临时文件记成成片）：project.json 的成片路径指回原成片', async () => {
    const { f, final } = redoFixture();
    const media = f.ctx.media as Partial<MediaDeps>;
    let tails = 0;
    f.ctx.media = { ...media, tail: async () => { tails += 1; if (tails === 2) throw new CancelledError(); return { before: -20, after: -20, attenuatedDb: 0 }; } };
    await runFirstVersion(f.ctx, f.spaceId).catch(() => undefined);
    expect(tails).toBe(2);
    expect(artifactsOf(f)).toMatchObject({ output: final(), final: final() });
    expect(existsSync(final())).toBe(true);
    expect(leftovers(f.store.versionDir(f.spaceId, 1))).toEqual([]);
  });

  it('重做时改名覆盖失败：撤回重做，project.json 的成片路径指回原成片', async () => {
    const { f, final } = redoFixture();
    const media = f.ctx.media as Partial<MediaDeps>;
    const loudness = media.loudness!;
    let calls = 0;
    // 第二次（重做）响度统一完成后把成片位置换成非空目录，让改名失败
    f.ctx.media = { ...media, loudness: async (input, output, cfg) => {
      calls += 1;
      const r = await loudness(input, output, cfg);
      if (calls === 2) { rmSync(final(), { force: true }); mkdirSync(final()); writeFileSync(join(final(), 'x'), 'x'); }
      return r;
    } };
    const meta = await runFirstVersion(f.ctx, f.spaceId);
    expect(meta.status).toBe('done');
    const project = JSON.parse(readFileSync(join(f.store.versionDir(f.spaceId, 1), 'project.json'), 'utf8')) as ProjectFile;
    expect(project.film?.unfixed.join('\n')).toMatch(/局部重做渲染失败，已撤回/);
    expect(project.artifacts).toMatchObject({ output: final(), final: final() });
    expect(leftovers(f.store.versionDir(f.spaceId, 1))).toEqual([]);
  });
});
