// 分镜规则：模板不连用超过 2 个、evidenceList ≤ 20% 时长、2 分钟内 ≥ 4 种呈现模式、徽章语义；持续演进 reveal 的换算与按字幕补齐
import { describe, expect, it } from 'vitest';
import { applyStoryboardRules, evidenceRatio, fixBadges, hasEvidence, longestRun, modeWindows, shotMode, storyboardIssues } from '../src/storyboard/rules.js';
import { fillReveal, revealToLocal } from '../src/storyboard/reveal.js';
import { normalizeStoryboard } from '../src/storyboard/normalize.js';
import type { CardSpec, Shot } from '../src/storyboard/schema.js';

type Row = { badge: '成本' | '收益' | '证据' | '来源' | '要点'; text: string };
const ev = (title: string, rows: Row[], extra: Record<string, unknown> = {}): CardSpec => ({ template: 'evidenceList', props: { title, rows, ...extra } }) as CardSpec;
const title = (t: string, subtitle?: string): CardSpec => ({ template: 'title', props: { title: t, ...(subtitle ? { subtitle } : {}) } });
const split = (start: number, end: number, card: CardSpec): Shot => ({ start, end, layout: 'split', card });
const full = (start: number, end: number): Shot => ({ start, end, layout: 'full' });
const hook = (i: number, total: number): CardSpec => ({ template: 'hook', props: { index: i, total, headline: `钩子 ${i}`, highlight: [] } });

/** try2（mv98vaan）的模型分镜，只保留文字：连续 3 张 evidenceList、evidenceList 占 43%、「证据」徽章当项目符号用 */
const D2 = 132.38;
const TRY2: Shot[] = [
  split(0, 4.8, hook(1, 2)),
  split(4.8, 10.5, { template: 'hook', props: { index: 2, total: 2, headline: 'AI快速迭代，企业面临双重缺口', highlight: ['双重缺口'], stat: { value: '技术 & 人才', label: '企业面临的双重缺口' } } }),
  full(10.5, 14.3),
  split(14.3, 18.2, title('FDE vs 传统驻场工程师', '它们之间到底有什么本质区别？')),
  split(18.2, 24, ev('两者的相似点', [{ badge: '证据', text: '都是乙方身份' }, { badge: '证据', text: '都需要做售前沟通' }, { badge: '证据', text: '涵盖需求、开发、部署与交付' }])),
  split(24, 27.8, { template: 'chips', props: { groups: [{ label: '交付流程', items: [{ text: '需求方案', mark: 'yes' }, { text: '开发部署', mark: 'yes' }] }] } }),
  full(27.8, 30.5),
  split(30.5, 37, { template: 'compareBars', props: { crumb: '传统驻场模式', items: [{ name: '客户提需求', value: 0.9, tone: 'good' }, { name: '按需开发', value: 0.8, tone: 'good' }] } }),
  split(37, 43.8, ev('传统合同约束', [{ badge: '证据', text: '需求清单写入合同，严禁超出范围' }, { badge: '证据', text: '目标明确，严格按约定功能交付' }])),
  split(43.8, 49.8, ev('改动次数极其有限', [{ badge: '成本', text: '仅允许改动 3-5 次' }, { badge: '成本', text: '严格限制在个位数' }])),
  split(49.8, 55.5, ev('线性依赖的特征', [{ badge: '证据', text: '每个环节严格依赖前序环节' }, { badge: '证据', text: '前序环节必须完成验收' }])),
  full(55.5, 62.3),
  split(62.3, 68.8, ev('1.0版本交付 vs 后期迭代修改', [{ badge: '成本', text: '1.0版本交付：极速上线，快速验证' }, { badge: '成本', text: '迭代与修改：持续优化，占用大量成本' }])),
  full(68.8, 74),
  split(74, 80.5, ev('FDE 目标导向', [{ badge: '收益', text: '为业务结果负责，关键在于“有用”' }, { badge: '成本', text: 'AI制作成本极低，交付不再是瓶颈' }])),
  split(80.5, 84, title('做的东西没用起来，FDE 工作就是失败的')),
  split(84, 91.3, title('驻场工程师 vs FDE', '按需求交付 vs 定义问题、验证结果')),
  full(91.3, 96),
  split(96, 103.8, ev('为什么企业需要FDE？', [{ badge: '来源', text: 'AI技术仍在快速变化' }, { badge: '成本', text: '企业流程、数据和人才跟不上' }])),
  split(103.8, 110.7, ev('FDE 的真正定义', [{ badge: '证据', text: '不是更高级的驻场工程师' }, { badge: '收益', text: '站在客户现场，帮企业把 AI 真正用起来' }])),
  full(110.7, 119.5),
  { start: 119.5, end: D2, layout: 'full', card: { template: 'cta', props: { actions: ['关注', '点赞', '收藏'] } } },
];

describe('徽章语义', () => {
  it('有数字、比例或明确出处才算证据', () => {
    for (const t of ['仅允许改动 3-5 次', 'Neal B 等 (2021) · NEJM', '死亡概率高约两成', '出自《高性价比人生指南》', '随机试验，近 30 万人']) expect(hasEvidence(t)).toBe(true);
    for (const t of ['都是乙方身份', 'AI技术仍在快速变化', '企业流程、数据和人才跟不上', '每个环节严格依赖前序环节']) expect(hasEvidence(t)).toBe(false);
  });
  it('「证据」「来源」用在普通观点上改成「要点」；成本、收益与带数据的行不动；其他模板原样返回', () => {
    const fixed = fixBadges(ev('t', [{ badge: '证据', text: '都是乙方身份' }, { badge: '来源', text: 'AI技术仍在快速变化' }, { badge: '证据', text: '随机试验 20995 人' }, { badge: '成本', text: '贵几元' }]));
    expect(fixed.template === 'evidenceList' && fixed.props.rows.map((r) => r.badge)).toEqual(['要点', '要点', '证据', '成本']);
    const t = title('标题');
    expect(fixBadges(t)).toBe(t);
  });
});

describe('呈现模式', () => {
  it('按版式与模板归类：人物全屏、文字卡、数据与图解、配图、截图、浮层', () => {
    expect(shotMode(full(0, 1))).toBe('person');
    expect(shotMode(split(0, 1, title('a')))).toBe('text');
    expect(shotMode(split(0, 1, { template: 'bigNumber', props: { value: '3', label: '次' } }))).toBe('graphic');
    expect(shotMode(split(0, 1, { template: 'flow', props: { steps: [{ label: '需求' }, { label: '交付' }] } }))).toBe('graphic');
    expect(shotMode(split(0, 1, { template: 'photo', props: { image: 'a.jpg' } }))).toBe('media');
    expect(shotMode(split(0, 1, { template: 'browser', props: { url: 'a.com' } }))).toBe('screen');
    expect(shotMode({ start: 0, end: 1, layout: 'overlay', card: title('a') })).toBe('overlay');
    expect(shotMode({ start: 0, end: 1, layout: 'broll', broll: { file: 'broll/a.jpg', kind: 'photo', focal: { x: 0.5, y: 0.5 } } })).toBe('media');
    expect(shotMode(split(0, 1, { template: 'hook', props: { index: 1, total: 1, headline: 'a', highlight: [], image: 'a.jpg' } }))).toBe('media');
    expect(shotMode(split(0, 1, hook(1, 1)))).toBe('text');
  });
  it('2 分钟滑动窗口；不足 60 秒的短片不检查', () => {
    expect(modeWindows([split(0, 30, title('a'))], 30)).toEqual([]);
    const w = modeWindows(TRY2, D2);
    expect(w[0]).toMatchObject({ start: 0, end: 120 });
    expect(w.every((x) => x.end - x.start === 120)).toBe(true);
  });
});

describe('applyStoryboardRules：try2 分镜按规则修正', () => {
  const { shots, fixes } = applyStoryboardRules(TRY2, D2);
  it('修正前能列出问题：同模板连用、evidenceList 超时长、徽章错用', () => {
    const issues = storyboardIssues(TRY2, D2);
    expect(issues.some((s) => s.includes('连续 3 个'))).toBe(true);
    expect(issues.some((s) => s.includes('evidenceList'))).toBe(true);
    expect(issues.some((s) => s.includes('徽章'))).toBe(true);
    expect(evidenceRatio(TRY2, D2)).toBeGreaterThan(0.35);
  });
  it('修正后：同一模板最多连续 2 个、evidenceList ≤ 20%、每个 2 分钟窗口 ≥ 4 种呈现模式、无问题', () => {
    expect(longestRun(shots)).toBeLessThanOrEqual(2);
    expect(evidenceRatio(shots, D2)).toBeLessThanOrEqual(0.2);
    for (const w of modeWindows(shots, D2)) expect(w.modes.length).toBeGreaterThanOrEqual(4);
    expect(storyboardIssues(shots, D2)).toEqual([]);
    expect(fixes.length).toBeGreaterThan(0);
  });
  it('时间轴不变（只换模板、版式或徽章），转换出的标题卡保留原来的标题与要点', () => {
    expect(shots.map((s) => [s.start, s.end])).toEqual(TRY2.map((s) => [s.start, s.end]));
    const converted = shots.find((s, i) => TRY2[i].card?.template === 'evidenceList' && s.card?.template === 'title');
    expect(converted?.card?.props).toMatchObject({ title: expect.any(String), subtitle: expect.any(String) });
  });
  it('不改入参', () => {
    expect(TRY2[4].card?.template === 'evidenceList' && TRY2[4].card.props.rows[0].badge).toBe('证据');
  });
});

describe('applyStoryboardRules：边界', () => {
  it('钩子连续 3 张不算违规', () => {
    const shots = [split(0, 3, hook(1, 3)), split(3, 6, hook(2, 3)), split(6, 9, hook(3, 3)), full(9, 12)];
    expect(applyStoryboardRules(shots, 12).shots).toEqual(shots);
  });
  it('呈现模式不足时把一张紧凑卡（标题、数字、标签）改成浮层；仍不足时留在问题里', () => {
    const big: CardSpec = { template: 'bigNumber', props: { value: '3', label: '次' } };
    const shots = [split(0, 20, title('a')), full(20, 40), split(40, 60, big), full(60, 80), split(80, 100, title('b')), full(100, 120)];
    const res = applyStoryboardRules(shots, 120);
    expect(res.shots.filter((s) => s.layout === 'overlay')).toHaveLength(1);
    expect(storyboardIssues(res.shots, 120)).toEqual([]);
    const poor = [split(0, 60, ev('x', [{ badge: '成本', text: '贵 3 元' }])), full(60, 120)];
    expect(storyboardIssues(applyStoryboardRules(poor, 120).shots, 120).some((s) => s.includes('呈现模式'))).toBe(true);
  });
});

describe('normalizeStoryboard 接入规则', () => {
  it('try2 原始分镜归一化后满足规则，并报告修正项', () => {
    const res = normalizeStoryboard({ shots: TRY2 }, D2, [], { fromModel: true });
    expect(longestRun(res.storyboard.shots)).toBeLessThanOrEqual(2);
    expect(evidenceRatio(res.storyboard.shots, D2)).toBeLessThanOrEqual(0.2);
    expect(res.ruleFixes?.length).toBeGreaterThan(0);
    // 已归一化的分镜再归一化（编辑、素材步骤）不套规则
    expect(normalizeStoryboard({ shots: TRY2 }, D2, []).ruleFixes ?? []).toEqual([]);
  });
  it('reveal：模型给的成片秒数换算成镜头内秒数；条数对不上的去掉', () => {
    const rows: Row[] = [{ badge: '成本', text: '贵 3 元' }, { badge: '收益', text: '省 5 小时' }, { badge: '成本', text: '多 1 步' }];
    const raw = { shots: [split(2, 10, title('a')), split(10, 16, ev('b', rows, { reveal: [10, 12.5, 14] })), full(16, 40), split(40, 46, ev('c', rows, { reveal: [40, 42] }))] };
    const lists = normalizeStoryboard(raw, 60, [], { fromModel: true }).storyboard.shots.filter((s) => s.card?.template === 'evidenceList');
    expect(lists[0].card?.props).toMatchObject({ reveal: [0, 2.5, 4] });
    expect(lists[1].card?.props).not.toHaveProperty('reveal');
  });
});

describe('reveal', () => {
  const rows: Row[] = [{ badge: '成本', text: '一' }, { badge: '收益', text: '二' }, { badge: '成本', text: '三' }];
  it('revealToLocal：夹进 [0, 镜头时长 − 0.5]、单调不减；全挤在开头的去掉', () => {
    const [a, b] = revealToLocal([split(10, 14, ev('a', rows, { reveal: [9, 12, 20] })), split(14, 18, ev('b', rows, { reveal: [14, 14.1, 14.2] }))]);
    expect(a.card?.props).toMatchObject({ reveal: [0, 2, 3.5] });
    expect(b.card?.props).not.toHaveProperty('reveal');
  });
  it('fillReveal：没写 reveal 的列表/对比/流程卡按镜头内字幕起点逐条出现；只有 1 句字幕或已写的不动', () => {
    const caps = [{ start: 10, end: 12, text: 'x' }, { start: 12, end: 14, text: 'y' }, { start: 14, end: 16, text: 'z' }, { start: 16, end: 20, text: 'w' }];
    const flow: CardSpec = { template: 'flow', props: { steps: [{ label: '需求' }, { label: '开发' }, { label: '验收' }] } };
    const shots = [split(10, 16, ev('a', rows)), split(16, 20, ev('b', rows)), split(10, 16, flow), split(10, 16, ev('c', rows, { reveal: [0, 1, 2] })), split(10, 16, title('t'))];
    const out = fillReveal(shots, caps);
    expect(out[0].card?.props).toMatchObject({ reveal: [0, 2, 4] });
    expect(out[1].card?.props).not.toHaveProperty('reveal');
    expect(out[2].card?.props).toMatchObject({ reveal: [0, 2, 4] });
    expect(out[3].card?.props).toMatchObject({ reveal: [0, 1, 2] });
    expect(out[4]).toBe(shots[4]);
  });
});
