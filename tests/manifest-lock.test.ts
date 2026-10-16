// --update-lock 的逻辑：哪些项要重下、已知 sha 不符换 url、过滤时保留旧条目。全程注入假下载函数，不联网。
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { hashFirstGood, needsRecompute, updateLockItems } from '../scripts/manifest-lock.mjs';
import { validateLock, type ManifestItem } from '../scripts/manifest-lib.mjs';
import { sourceItems } from '../scripts/manifest-sources.mjs';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const draftOf = (id: string, extra: Partial<ManifestItem> = {}): ManifestItem => ({
  id, kind: 'model', platform: 'any', dest: `data/models/${id}`, urls: [`https://m.example/${id}`, `https://o.example/${id}`], ...extra,
});
const lockedOf = (id: string, body = id): ManifestItem => ({ ...draftOf(id), sha256: sha(body), size: body.length });

/** 记录被下载的 url；bodies 按 url 返回内容，没有则抛错 */
function fakeHash(bodies: Record<string, string>) {
  const calls: string[] = [];
  const hash = async (url: string) => {
    calls.push(url);
    const body = bodies[url];
    if (body === undefined) throw new Error('HTTP 404');
    return { sha256: sha(body), size: body.length };
  };
  return { calls, hash };
}

describe('needsRecompute', () => {
  it('url 与已知 sha 都没变 -> 不重下，即使键顺序、元数据（exec/optional/dest）不同', () => {
    const old = lockedOf('a');
    // 键顺序完全不同的 draft（与 zod 输出顺序无关）
    const draft = { urls: [...old.urls], optional: true, exec: 'x/y', dest: 'data/other', kind: 'model', platform: 'any', id: 'a' };
    expect(needsRecompute(old, draft)).toBe(false);
  });

  it('新增条目、url 变化、已知 sha 与旧值不同 -> 重下', () => {
    const old = lockedOf('a');
    expect(needsRecompute(undefined, draftOf('a'))).toBe(true);
    expect(needsRecompute(old, draftOf('a', { urls: ['https://new.example/a'] }))).toBe(true);
    expect(needsRecompute(old, draftOf('a', { sha256: sha('other') }))).toBe(true);
    expect(needsRecompute(old, draftOf('a', { sha256: old.sha256 }))).toBe(false);
  });
});

describe('hashFirstGood', () => {
  it('已知 sha256 不符（镜像 200 返回限流页）时换下一个 url，且不重试同一个', async () => {
    const draft = draftOf('a', { sha256: sha('real') });
    const { calls, hash } = fakeHash({ [draft.urls[0]]: '429 too many', [draft.urls[1]]: 'real' });
    expect(await hashFirstGood(draft, { hash })).toEqual({ sha256: sha('real'), size: 4 });
    expect(calls).toEqual(draft.urls);
  });

  it('网络失败同一 url 重试一次再换下一个；全部失败则报错', async () => {
    const draft = draftOf('a');
    const { calls, hash } = fakeHash({});
    await expect(hashFirstGood(draft, { hash })).rejects.toThrow(/所有 url/);
    expect(calls).toEqual([draft.urls[0], draft.urls[0], draft.urls[1], draft.urls[1]]);
  });
});

describe('updateLockItems', () => {
  it('未变的项不重下：只算新增项，旧项沿用 sha256/size，元数据跟随 draft', async () => {
    const existing = [lockedOf('a'), lockedOf('b')];
    const drafts = [draftOf('a', { optional: true }), draftOf('b'), draftOf('c')];
    const { calls, hash } = fakeHash({ [drafts[2].urls[0]]: 'ccc' });
    const items = await updateLockItems({ drafts, existing, wanted: new Set(['a', 'b', 'c']), hash });
    expect(calls).toEqual([drafts[2].urls[0]]);
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(items[0]).toMatchObject({ optional: true, sha256: existing[0].sha256, size: existing[0].size });
    expect(items[2]).toMatchObject({ sha256: sha('ccc'), size: 3 });
  });

  it('--force 全部重算', async () => {
    const existing = [lockedOf('a')];
    const drafts = [draftOf('a')];
    const { calls, hash } = fakeHash({ [drafts[0].urls[0]]: 'a' });
    await updateLockItems({ drafts, existing, wanted: new Set(['a']), force: true, hash });
    expect(calls).toHaveLength(1);
  });

  it('带过滤时被过滤的项保留旧条目（原样），只重算 wanted 内的', async () => {
    const existing = [lockedOf('a'), lockedOf('b')];
    const drafts = [draftOf('a', { urls: ['https://changed.example/a'] }), draftOf('b', { urls: ['https://changed.example/b'] })];
    const { calls, hash } = fakeHash({ 'https://changed.example/b': 'bb' });
    const items = await updateLockItems({ drafts, existing, wanted: new Set(['b']), hash });
    expect(calls).toEqual(['https://changed.example/b']);
    expect(items[0]).toEqual(existing[0]); // a 没动，哪怕它的来源已变
    expect(items[1]).toMatchObject({ id: 'b', sha256: sha('bb') });
  });

  it('每算完一项就 save，且包含后面还没轮到的旧条目，中断后可续', async () => {
    const existing = [lockedOf('b')];
    const drafts = [draftOf('a'), draftOf('b', { urls: ['https://changed.example/b'] })];
    const { hash } = fakeHash({ [drafts[0].urls[0]]: 'aa', 'https://changed.example/b': 'bb' });
    const saved: string[][] = [];
    await updateLockItems({ drafts, existing, wanted: new Set(['a', 'b']), hash, save: (xs) => saved.push(xs.map((i) => i.id)) });
    expect(saved).toEqual([['a', 'b'], ['a', 'b']]);
  });
});

describe('来源定义（manifest-sources）', () => {
  it('所有 url 都固定到版本/提交，不引用分支名', () => {
    const branchRef = /(\/(main|master|HEAD|latest|develop)\/|@(main|master|HEAD|latest)\/|\/resolve\/(main|master)\/)/;
    for (const item of sourceItems()) for (const url of item.urls) expect(url, `${item.id}: ${url}`).not.toMatch(branchRef);
  });

  it('素材（配乐、字体）全部 optional，其余类型都不是 optional', () => {
    for (const item of sourceItems()) expect(item.optional === true, item.id).toBe(item.kind === 'asset');
  });

  it('来源定义产出的条目除 sha256/size 外都能通过 schema', () => {
    const filled = sourceItems().map((i) => ({ ...i, sha256: sha(i.id), size: 1 }));
    expect(() => validateLock({ schemaVersion: 1, items: filled })).not.toThrow();
  });
});
