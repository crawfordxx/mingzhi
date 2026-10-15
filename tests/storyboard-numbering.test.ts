import { describe, expect, it } from 'vitest';
import { normalizeStoryboard } from '../src/storyboard/normalize.js';
import { unifyListNumbering } from '../src/storyboard/numbering.js';
import type { Shot } from '../src/storyboard/schema.js';

const hook: Shot = { start: 0, end: 2, layout: 'split', card: { template: 'hook', props: { index: 1, total: 1, headline: '3个提高效率的小习惯', highlight: ['提高效率'] } } };
const title = (t: string, start: number): Shot => ({ start, end: start + 2, layout: 'split', card: { template: 'title', props: { title: t } } });
const toggles = (t: string, start: number): Shot => ({ start, end: start + 2, layout: 'split', card: { template: 'toggles', props: { title: t, rows: [{ label: '手机放隔壁', on: true }] } } });
const evidence = (t: string, start: number): Shot => ({ start, end: start + 2, layout: 'split', card: { template: 'evidenceList', props: { title: t, rows: [{ badge: '收益', text: '清空大脑' }] } } });
const full = (start: number): Shot => ({ start, end: start + 2, layout: 'full' });
const titles = (shots: Shot[]): (string | undefined)[] => shots.map((s) => (s.card?.props as { title?: string; headline?: string } | undefined)?.title);

describe('unifyListNumbering：同一组列表要么都编号、要么都不编号', () => {
  it('竖屏 v1：「1. …」「远离手机干扰」「3. …」→ 中间那张补上「2. 」', () => {
    const shots = [hook, title('1. 早上先做最难的事', 2), toggles('远离手机干扰', 4), evidence('3. 睡前规划明天', 6)];
    const out = unifyListNumbering(shots);
    expect(titles(out)).toEqual([undefined, '1. 早上先做最难的事', '2. 远离手机干扰', '3. 睡前规划明天']);
    expect(out[0]).toBe(shots[0]);
    expect(shots[2].card?.props).toEqual({ title: '远离手机干扰', rows: [{ label: '手机放隔壁', on: true }] });
  });
  it('序号用的分隔符跟前一张一致（「1、」→「2、」）；全屏镜头不算列表项', () => {
    const out = unifyListNumbering([title('1、早起', 0), full(2), title('多喝水', 4), full(6), title('3、早睡', 8)]);
    expect(titles(out)).toEqual(['1、早起', undefined, '2、多喝水', undefined, '3、早睡']);
  });
  it('编号本来就连续：中间夹的不相干卡片不动', () => {
    const shots = [title('1. 早起', 0), title('2. 多喝水', 2), toggles('设置', 4), title('3. 早睡', 6)];
    expect(unifyListNumbering(shots)).toEqual(shots);
  });
  it('缺号和中间的卡片数对不上（缺 1 个、夹了 2 张）：这一组都去掉编号', () => {
    const out = unifyListNumbering([title('1. 早起', 0), title('多喝水', 2), title('运动', 4), title('3. 早睡', 6)]);
    expect(titles(out)).toEqual(['早起', '多喝水', '运动', '早睡']);
  });
  it('补上序号会超出字段长度上限：这一组都去掉编号', () => {
    const long = '很'.repeat(23);
    const out = unifyListNumbering([title('1. 早起', 0), toggles(long, 2), title('3. 早睡', 4)]);
    expect(titles(out)).toEqual(['早起', long, '早睡']);
  });
  it('没有编号、只有一张编号：原样返回', () => {
    const plain = [title('早起', 0), title('早睡', 2)];
    expect(unifyListNumbering(plain)).toEqual(plain);
    const one = [title('1. 早起', 0), title('早睡', 2)];
    expect(unifyListNumbering(one)).toEqual(one);
  });
  it('normalizeStoryboard 的输出已统一编号', () => {
    const raw = { shots: [title('1. 早上先做最难的事', 0), toggles('远离手机干扰', 2), evidence('3. 睡前规划明天', 4)] };
    expect(titles(normalizeStoryboard(raw, 6, []).storyboard.shots)).toEqual(['1. 早上先做最难的事', '2. 远离手机干扰', '3. 睡前规划明天']);
  });
});
