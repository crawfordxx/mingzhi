// 工作台版本运行器接 B-roll 编排：首版规划节拍放素材、写 credits.json；修改版本「换一张 B-roll」只重做该镜头
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { VersionState } from '../src/edit/apply.js';
import type { ProjectFile } from '../src/pipeline/project.js';
import { runFirstVersion, runNextVersion } from '../src/workspace/runner.js';
import { beatJson, brollAnswers, fakeBrollDeps, makeBrollFixtures, POOL, wiki } from './helpers/broll-fakes.js';
import { makeFixture, type Fixture } from './helpers/runner-fakes.js';

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const BEATS = { beats: [beatJson(2.2, 3.8, 'broll-full'), beatJson(6.2, 7.8, 'pip')] };

beforeAll(async () => { await makeBrollFixtures(); });

/** 运行器的模型换成「节拍、审片、主体定位有假回答，其余照旧」，素材依赖带假 Wikimedia */
function withBroll(f: Fixture, labels: string[][]): void {
  const base = f.ctx.clients;
  f.ctx.clients = (meter) => {
    const c = base(meter);
    const llm = brollAnswers(BEATS, { fallback: c.llm });
    labels.push(llm.labels);
    return { ...c, llm };
  };
  f.ctx.brollDeps = () => fakeBrollDeps([wiki(POOL)]).deps;
}

describe('运行器 × B-roll 编排', () => {
  it('首版放素材并写 credits.json；「换一张 B-roll」只重做该镜头（changedShots 只含它）、不重新规划；素材面板标了 remove 的去掉', async () => {
    const f = makeFixture();
    const labels: string[][] = [];
    withBroll(f, labels);
    await runFirstVersion(f.ctx, f.spaceId);
    const dir1 = f.store.versionDir(f.spaceId, 1);
    const s1 = readJson<VersionState>(join(dir1, 'state.json')).storyboard;
    const withB = s1.shots.flatMap((s, i) => (s.broll ? [i] : []));
    expect(withB).toHaveLength(2);
    expect(s1.shots[withB[0]].layout).toBe('broll');
    for (const i of withB) expect(existsSync(join(dir1, s1.shots[i].broll?.file ?? ''))).toBe(true); // 素材引用进版本目录
    const credits1 = readJson<{ file: string; source: string }[]>(join(dir1, 'credits.json'));
    expect(credits1.map((c) => c.source)).toEqual(['wikimedia', 'wikimedia']);
    expect(readJson<ProjectFile>(join(dir1, 'project.json')).broll?.beats).toHaveLength(2);

    const k = withB[0];
    const meta2 = await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'replaceBroll', shotIndex: k }], '换一张 B-roll');
    expect(labels.at(-1)).not.toContain('视觉节拍');
    const dir2 = f.store.versionDir(f.spaceId, 2);
    const s2 = readJson<VersionState>(join(dir2, 'state.json')).storyboard;
    expect(s2.shots[k].broll?.file).not.toBe(s1.shots[k].broll?.file);
    expect(s2.shots[withB[1]]).toEqual(s1.shots[withB[1]]);
    expect(meta2.changedShots).toEqual([k]);
    expect(readJson<{ file: string }[]>(join(dir2, 'credits.json')).map((c) => c.file)).toContain(s2.shots[k].broll?.file);

    // 素材面板：另一个镜头标了 remove，这个镜头标了 replace；只提交另一个镜头的 op → 只处理它
    const other = withB[1];
    writeFileSync(join(dir2, 'credits-marks.json'), JSON.stringify({ [s2.shots[other].broll?.file ?? '']: { action: 'remove', at: 1 }, [s2.shots[k].broll?.file ?? '']: { action: 'replace', at: 1 } }));
    const meta3 = await runNextVersion(f.ctx, f.spaceId, 2, [{ type: 'replaceBroll', shotIndex: other }], '去掉素材');
    const s3 = readJson<VersionState>(join(f.store.versionDir(f.spaceId, 3), 'state.json')).storyboard;
    expect(s3.shots.some((s) => s.broll?.file === s2.shots[other].broll?.file)).toBe(false);
    expect(s3.shots.find((s) => s.broll)?.broll?.file).toBe(s2.shots[k].broll?.file); // 标了 replace 但没提交的不动
    expect(meta3.changedShots.length).toBeGreaterThan(0);
  }, 120_000);
});
