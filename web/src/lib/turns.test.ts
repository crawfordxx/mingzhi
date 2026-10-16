import { describe, expect, it } from 'vitest';
import { mergeTurns, sanitizeTurns, saidFor, type Turn } from './turns';

const ai = { id: 'a', kind: 'ai', at: 2, base: 1, reply: '好', options: [{ label: 'A', ops: [{ type: 'pace', direction: 'tighter' }] }] };

describe('对话记录（服务端返回）的校验', () => {
  it('不是数组时为空', () => {
    expect(sanitizeTurns(null)).toEqual([]);
    expect(sanitizeTurns({ a: 1 })).toEqual([]);
  });

  it('结构不对的条目丢掉，好的留下', () => {
    const out = sanitizeTurns([
      { id: 'u', kind: 'user', at: 1, base: 1, message: '@00:03 标题卡 改一下' },
      ai,
      { ...ai, id: 'b', options: '不是数组' },
      { ...ai, id: 'c', options: [{ label: 1, ops: [] }] },
      { id: 'd', kind: 'user', at: '1', base: 1, message: 'x' },
      { id: 'e', kind: 'other', at: 1, base: 1 },
      'garbage',
    ]);
    expect(out.map((t) => t.id)).toEqual(['u', 'a']);
  });

  it('刷新前在途的执行：不确定是否已提交，锁住选项；等回复中的标为没等到', () => {
    const [applying, pending] = sanitizeTurns([{ ...ai, picked: 0, applying: true }, { id: 'p', kind: 'ai', at: 3, base: 1, pending: true }]);
    expect(applying).toMatchObject({ applying: false, unsure: true, picked: 0 });
    expect(pending).toMatchObject({ pending: false });
    expect((pending as { error?: string }).error).toContain('没有等到');
  });
});

describe('服务端与本机在途条目合并', () => {
  const user: Turn = { id: 'u1', kind: 'user', at: 1, base: 1, message: '换字体' };
  const done: Turn = { id: 'a1', kind: 'ai', at: 2, base: 1, reply: '好', picked: 0, applied: 2 };

  it('以服务端为准；本机还在等回复或正在执行的条目保留本机的样子；服务端没有的本机条目接在后面（按时间）', () => {
    const local: Turn[] = [
      { ...user, message: '本机旧文字' },
      { id: 'a1', kind: 'ai', at: 2, base: 1, reply: '好', applying: true, picked: 0 },
      { id: 'u2', kind: 'user', at: 5, base: 2, message: '再改' },
      { id: 'a2', kind: 'ai', at: 6, base: 2, pending: true },
    ];
    const out = mergeTurns([user, { ...done, applied: undefined, picked: undefined }], local);
    expect(out.map((t) => t.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(out[0]).toEqual(user);
    expect(out[1]).toMatchObject({ applying: true });
    expect(out[3]).toMatchObject({ pending: true });
  });
  it('服务端已有结果时用服务端的', () => {
    expect(mergeTurns([user, done], [user, { id: 'a1', kind: 'ai', at: 2, base: 1, reply: '好' }])).toEqual([user, done]);
  });
});

describe('版本卡上触发它的那句话', () => {
  const turns: Turn[] = [
    { id: 'u1', kind: 'user', at: 1, base: 1, message: '@00:07 这张卡换成大字标题' },
    { id: 'a1', kind: 'ai', at: 2, base: 1, reply: '好', applied: 2 },
    { id: 'u2', kind: 'user', at: 3, base: 2, message: '只是问问' },
    { id: 'a2', kind: 'ai', at: 4, base: 2, reply: '是标题卡' },
  ];
  it('执行出这一版的回复所回应的那句话；找不到返回 undefined', () => {
    expect(saidFor(turns, 2)).toBe('@00:07 这张卡换成大字标题');
    expect(saidFor(turns, 3)).toBeUndefined();
  });
});
