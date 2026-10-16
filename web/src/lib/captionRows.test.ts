import { describe, expect, it } from 'vitest';
import { captionRows, transcriptRows } from './captionRows';
import type { CapLine, CutMark, TxLine } from './liveModel';

/** 「大家好嗯今天聊聊怎么用ai剪口播」：嗯（3）被剪；ai 是两个 token */
const tokens = ['大', '家', '好', '嗯', '今', '天', '聊', '聊', '怎', '么', '用', 'ai', '剪', '口', '播', '要', '呃', '要', '两', '三', '个', '小', '时'];
const tx: TxLine[] = [{ from: 0, start: 0, end: 5, text: tokens.join(''), tokens }];
const cuts: CutMark[] = [{ from: 3, to: 3, type: 'filler' }, { from: 15, to: 16, type: 'repeat' }];
const caps: CapLine[] = [
  { from: 0, to: 2, text: '大家好' },
  { from: 4, to: 14, text: '今天聊聊怎么用 AI 剪口播' },
  { from: 17, to: 22, text: '要两三个小时' },
];

describe('直播转录显示校对后的字幕', () => {
  it('每行是校对后的文字；两行之间被剪的词标在下一行开头，行内被剪的词插在对应位置', () => {
    const rows = captionRows(caps, tx, cuts);
    expect(rows.map((r) => r.parts)).toEqual([
      [{ text: '大家好', cut: false }],
      [{ text: '嗯', cut: true }, { text: '今天聊聊怎么用 AI 剪口播', cut: false }],
      [{ text: '要呃', cut: true }, { text: '要两三个小时', cut: false }],
    ]);
    expect(rows.map((r) => r.key)).toEqual(['c0', 'c4', 'c17']);
  });
  it('行内被剪：按保留字数估算插入位置', () => {
    const rows = captionRows([{ from: 0, to: 7, text: '大家好今天聊聊' }], tx, [{ from: 3, to: 3, type: 'filler' }]);
    expect(rows[0].parts).toEqual([{ text: '大家好', cut: false }, { text: '嗯', cut: true }, { text: '今天聊聊', cut: false }]);
  });
  it('行内位置不算标点和校对加的空格', () => {
    const t2: TxLine[] = [{ from: 0, start: 0, end: 1, text: '', tokens: ['用', 'ai', '，', '呃', '剪', '口', '播'] }];
    const rows = captionRows([{ from: 0, to: 6, text: '用 AI 剪口播' }], t2, [{ from: 3, to: 3, type: 'filler' }]);
    expect(rows[0].parts).toEqual([{ text: '用 AI', cut: false }, { text: '呃', cut: true }, { text: ' 剪口播', cut: false }]);
  });
  it('最后一行之后被剪的词接在最后一行末尾', () => {
    const rows = captionRows([{ from: 0, to: 2, text: '大家好' }], tx, [{ from: 3, to: 4, type: 'filler' }]);
    expect(rows[0].parts).toEqual([{ text: '大家好', cut: false }, { text: '嗯今', cut: true }]);
  });
  it('没有字幕时用识别原文（与之前一致）', () => {
    const rows = transcriptRows(tx, cuts);
    expect(rows[0].parts.slice(0, 3)).toEqual([{ text: '大家好', cut: false }, { text: '嗯', cut: true }, { text: '今天聊聊怎么用ai剪口播', cut: false }]);
    expect(rows[0].key).toBe('t0');
  });
});
