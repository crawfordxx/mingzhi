import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOOD_KEY, spaceWithInput, startTestApp, waitFor, type TestApp } from './server-fixture.js';

let t: TestApp;
afterEach(async () => { await t?.close(); });

const PLAN = { reply: '换成宋韵还是文楷？', ops: [], options: [{ label: '宋韵', ops: [{ type: 'setCaptionStyle', id: 'song' }] }, { label: '文楷', ops: [{ type: 'setCaptionStyle', id: 'wenkai' }] }] };
const chatDeps = (reply: unknown = PLAN) => ({ planClient: () => ({ chatJson: async () => reply }) });
const done = (id: string, n: number) => async (): Promise<boolean> =>
  ((await t.call('GET', `/api/spaces/${id}`)).json.versions as { n: number; status: string }[]).find((v) => v.n === n)?.status === 'done';
const chatOf = async (id: string) => (await t.call('GET', `/api/spaces/${id}/chat`)).json.turns;

async function firstDone(): Promise<string> {
  const id = await spaceWithInput(t);
  await t.call('POST', `/api/spaces/${id}/start`);
  await waitFor(done(id, 1));
  return id;
}

describe('对话记录存在服务端（<space>/chat.jsonl）', () => {
  it('新项目没有对话：GET chat 返回空列表', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const id = (await t.call('POST', '/api/spaces', {})).json.id as string;
    expect(await t.call('GET', `/api/spaces/${id}/chat`)).toMatchObject({ status: 200, json: { turns: [] } });
    expect((await t.call('GET', '/api/spaces/nope/chat')).status).toBe(404);
  });

  it('发消息：存下用户的话与 AI 回复（含选项、基于哪一版），沿用前端给的条目 id', async () => {
    t = await startTestApp({ key: GOOD_KEY, deps: chatDeps() });
    const id = await firstDone();
    const r = await t.call('POST', `/api/spaces/${id}/messages`, { message: '@00:07 字幕换个字体', turn: { user: 'u1abcdef', ai: 'a1abcdef' } });
    expect(r.status).toBe(200);
    expect(r.json.turnId).toBe('a1abcdef');
    const turns = await chatOf(id);
    expect(turns).toEqual([
      { id: 'u1abcdef', kind: 'user', at: expect.any(Number), base: 1, message: '@00:07 字幕换个字体' },
      { id: 'a1abcdef', kind: 'ai', at: expect.any(Number), base: 1, reply: PLAN.reply, ops: [], options: PLAN.options },
    ]);
    expect(readFileSync(join(t.app.store.baseDir(id), '..', 'chat.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('执行选项：记下点了第几个、出了哪一版、实际执行的操作', async () => {
    t = await startTestApp({ key: GOOD_KEY, deps: chatDeps() });
    const id = await firstDone();
    const { turnId } = (await t.call('POST', `/api/spaces/${id}/messages`, { message: '换字体' })).json;
    expect(typeof turnId).toBe('string');
    const r = await t.call('POST', `/api/spaces/${id}/apply`, { ops: PLAN.options[1].ops, summary: '文楷', turn: turnId, picked: 1 });
    expect(r.status).toBe(202);
    await waitFor(done(id, 2));
    const ai = (await chatOf(id)).find((x: { id: string }) => x.id === turnId);
    expect(ai).toMatchObject({ picked: 1, applied: 2, appliedOps: [{ type: 'setCaptionStyle', id: 'wenkai' }], dropped: [] });
  });

  it('规划失败或预算不够也留下记录：用户的话 + 带错误原因的回复', async () => {
    t = await startTestApp({ key: GOOD_KEY, deps: { planClient: () => ({ chatJson: async () => { throw new Error('模型超时'); } }) } });
    const id = await firstDone();
    expect((await t.call('POST', `/api/spaces/${id}/messages`, { message: '换个背景' })).status).toBe(502);
    await t.call('PATCH', `/api/spaces/${id}`, { settings: { budgetYuan: 0.5 } });
    expect((await t.call('POST', `/api/spaces/${id}/messages`, { message: '再试一次' })).status).toBe(402);
    const turns = await chatOf(id);
    expect(turns.map((x: { kind: string; message?: string; error?: string }) => [x.kind, x.message ?? x.error])).toEqual([
      ['user', '换个背景'], ['ai', expect.stringContaining('模型超时')], ['user', '再试一次'], ['ai', expect.stringContaining('已接近上限')],
    ]);
  });

  it('前端给的 id 不合规就由服务端生成；坏行跳过', async () => {
    t = await startTestApp({ key: GOOD_KEY, deps: chatDeps({ reply: '好', ops: [] }) });
    const id = await firstDone();
    const r = await t.call('POST', `/api/spaces/${id}/messages`, { message: '你好', turn: { user: '../x', ai: 'a'.repeat(200) } });
    expect(r.json.turnId).toMatch(/^[a-z0-9]{6,32}$/);
    appendFileSync(join(t.app.store.baseDir(id), '..', 'chat.jsonl'), '不是 JSON\n{"type":"ai"}\n');
    const turns = await chatOf(id);
    expect(turns).toHaveLength(2);
    expect(turns[0].id).not.toBe('../x');
  });
});
