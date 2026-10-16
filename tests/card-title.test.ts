import { describe, expect, it } from 'vitest';
import { completeCardTitles, isCompleteTitle } from '../src/storyboard/card-title.js';
import { normalizeStoryboard } from '../src/storyboard/normalize.js';
import type { Shot } from '../src/storyboard/schema.js';

const cap = (start: number, end: number, text: string) => ({ start, end, text });
const titleShot = (start: number, end: number, title: string, extra: Record<string, string> = {}): Shot => ({ start, end, layout: 'split', card: { template: 'title', props: { title, ...extra } } });

describe('isCompleteTitle：标题是完整意思', () => {
  it.each([
    '早上先做最难的事', '第一个习惯：早上先做最难的事', 'AI 剪口播神器', '三个提高效率的小习惯', '睡前列出明天的清单', '传统剪辑 2-3 小时', '目的', '为什么要这么做？', '这样才对',
  ])('完整：%s', (t) => expect(isCompleteTitle(t)).toBe(true));
  it.each([
    '第三个习惯：每天睡前', '习惯三：', '提高效率的', '工作和', '先列清单，然后', '每天', '早上', '有了它以后', '做事先把', '关于时间管理的',
  ])('话没说完：%s', (t) => expect(isCompleteTitle(t)).toBe(false));
});

describe('completeCardTitles：话说一半的标题改成完整的', () => {
  const captions = [cap(7.085, 8.839, '手机放到另一个房间'), cap(9.369, 10.029, '第三个'), cap(10.029, 10.869, '每天睡前'), cap(10.869, 12.007, '列出明天的清单')];

  it('用该镜头字幕里的完整句子补全：保留冒号前的序号，冒号后换成整句', () => {
    const { shots, fixes } = completeCardTitles([titleShot(9, 10.1, '第三个习惯：每天睡前')], captions);
    expect(shots[0].card?.template === 'title' && shots[0].card.props.title).toBe('第三个习惯：每天睡前列出明天的清单');
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toContain('第三个习惯：每天睡前');
  });
  it('补全后太长一行放不下：只用整句；整句也太长：去掉冒号后的半句，留冒号前', () => {
    const long = [cap(9, 10, '每天睡前'), cap(10, 12, '先把明天最重要的三件事一条一条认真地写下来')];
    const a = completeCardTitles([titleShot(9, 12, '第三个习惯：每天睡前')], long).shots[0].card;
    expect(a?.template === 'title' && a.props.title).toBe('第三个习惯');
    const mid = [cap(9, 10, '每天睡前'), cap(10, 11.5, '写下明天的清单')];
    const b = completeCardTitles([titleShot(9, 12, '第三个习惯很重要的一条规矩：每天睡前')], mid).shots[0].card;
    expect(b?.template === 'title' && b.props.title).toBe('每天睡前写下明天的清单');
  });
  it('字幕里找不到可补的句子：去掉冒号后的半句', () => {
    const { shots } = completeCardTitles([titleShot(0, 3, '第三个习惯：每天睡前')], [cap(0, 3, '别的内容')]);
    expect(shots[0].card?.template === 'title' && shots[0].card.props.title).toBe('第三个习惯');
  });
  it('没有冒号也补不出来：保留原样并报告（unfixed）', () => {
    const r = completeCardTitles([titleShot(0, 3, '提高效率的')], [cap(0, 3, '别的内容')]);
    expect(r.shots[0].card?.template === 'title' && r.shots[0].card.props.title).toBe('提高效率的');
    expect(r.unfixed).toHaveLength(1);
  });
  it('完整的标题与其他镜头原样返回（同一个对象），不改入参', () => {
    const ok = titleShot(0, 3, '早上先做最难的事', { subtitle: '吃掉那只青蛙' });
    const full: Shot = { start: 3, end: 5, layout: 'full' };
    const input = [ok, full];
    const snapshot = JSON.stringify(input);
    const r = completeCardTitles(input, captions);
    expect(r.shots[0]).toBe(ok);
    expect(r.shots[1]).toBe(full);
    expect(r.fixes).toEqual([]);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
  it('钩子标题同样处理，并去掉不再是子串的高亮词', () => {
    const hook: Shot = { start: 0, end: 3, layout: 'split', card: { template: 'hook', props: { index: 1, total: 1, headline: '三个习惯：每天睡前', highlight: ['每天睡前', '三个习惯'] } } };
    const r = completeCardTitles([hook], [cap(0, 1, '每天睡前'), cap(1, 2.5, '写下明天的清单')]);
    const card = r.shots[0].card;
    expect(card?.template === 'hook' && card.props.headline).toBe('三个习惯：每天睡前写下明天的清单');
    expect(card?.template === 'hook' && card.props.highlight.every((h) => card.props.headline.includes(h))).toBe(true);
  });
});

describe('normalizeStoryboard：模型分镜的标题完整性校验', () => {
  const captions = [cap(0, 2, '前面的话'), cap(2, 3, '每天睡前'), cap(3, 5, '列出明天的清单')];
  const raw = { shots: [{ start: 0, end: 2, layout: 'full' }, { start: 2, end: 5, layout: 'split', card: { template: 'title', props: { title: '第三个习惯：每天睡前' } } }] };
  it('给了字幕：fromModel 时自动补全，并在 titleFixes 里留记录', () => {
    const res = normalizeStoryboard(raw, 5, [], { fromModel: true, captions });
    const card = res.storyboard.shots.find((s) => s.card)?.card;
    expect(card?.template === 'title' && card.props.title).toBe('第三个习惯：每天睡前列出明天的清单');
    expect(res.titleFixes).toHaveLength(1);
    expect(res.titleIssues).toEqual([]);
  });
  it('补不出来的标题记入 titleIssues（供重试提示用）；没给字幕时不检查', () => {
    const res = normalizeStoryboard({ shots: [{ start: 0, end: 5, layout: 'split', card: { template: 'title', props: { title: '提高效率的' } } }] }, 5, [], { fromModel: true, captions: [cap(0, 5, '别的')] });
    expect(res.titleIssues).toHaveLength(1);
    const none = normalizeStoryboard(raw, 5, [], { fromModel: true });
    expect(none.titleFixes).toBeUndefined();
  });
});
