import { describe, expect, it } from 'vitest';
import { sanitizeTurns } from './turns';

const ai = { id: 'a', kind: 'ai', at: 2, base: 1, reply: '好', options: [{ label: 'A', ops: [{ type: 'pace', direction: 'tighter' }] }] };

describe('本机对话记录的校验', () => {
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
