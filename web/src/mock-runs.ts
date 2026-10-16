/**
 * 假数据层的出片与修改（?mock=1）：用一段固定脚本模拟剪辑直播事件（形状与 src/pipeline/detail.ts 一致），
 * 修改返回固定方案、执行后出新版本。没有真实成片，播放器只有画框。
 */
import type { Api, EditOp, EventSink, Space, VersionMeta, VersionState, WorkEvent } from './api';
import { ApiError } from './api';
import { isFirst } from './lib/versions';

type Find = { find: (id: string) => Space; replace: (next: Space) => Space };
type Ev = Omit<WorkEvent, 'seq' | 't' | 'spaceId' | 'version'> & { at: number };

const TX = ['吃抗氧化补剂的人，呃，死亡率反而更高一些', '然后呢，嗯，我平时经常在 GitHub 上面去逛 AI 项目', '这个项目里面一共讲了六百六百五十条', '第一点呢，它就，它就建议我少喝饮料'];
const CUTS: [number, number, string][] = [[9, 10, 'filler'], [20, 25, 'filler'], [56, 57, 'repeat'], [75, 77, 'repeat']];
const TEMPLATES = ['hook', 'title', 'bigNumber', 'compareBars', 'evidenceList', 'strikeList'];
const SHOTS = Array.from({ length: 18 }, (_, i) => {
  const full = i % 3 === 2;
  return {
    index: i, start: i * 6.5, end: (i + 1) * 6.5, layout: (full ? 'full' : 'split') as 'split' | 'full',
    ...(full ? {} : { template: TEMPLATES[i % 6], title: `第 ${i + 1} 镜` }),
  };
});

function transcript() {
  let from = 0;
  return TX.map((text, i) => {
    const tokens = [...text];
    const line = { from, start: i * 3, end: i * 3 + 2.6, text, tokens };
    from += tokens.length;
    return line;
  });
}

/** 校对后的字幕：每个识别行一行，去掉被剪的字与标点，个别字按校对改写（演示「转录 · 已校对」） */
function captionLines() {
  const cut = new Set(CUTS.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, k) => from + k)));
  return transcript().map((l) => {
    const kept = l.tokens.filter((t, k) => !cut.has(l.from + k) && !/[，。、]/.test(t)).join('');
    return { from: l.from, to: l.from + l.tokens.length - 1, text: kept.replace('六百五十条', '650 条') };
  });
}

const cost = (at: number, total: number): Ev =>
  ({ at, step: 'probe', message: `已花费 ¥${total.toFixed(2)}`, detail: { kind: 'cost', data: { total, budget: 10 } } });
const pct = (at: number, step: string, p: number): Ev =>
  ({ at, step, message: `${step} ${p}%`, detail: { kind: 'progress', data: { stage: step === 'matte' ? 'matte' : 'compose', pct: p } } });

function firstScript(): Ev[] {
  const score = { layout: 9.1, hierarchy: 8.8, motion: 8.6, brand: 9.3 };
  const qa = SHOTS.filter((s) => s.layout === 'split').map((s, k): Ev => ({
    at: 7600 + k * 90, step: 'qa-cards', message: `第 ${s.index + 1} 镜卡片自检`,
    detail: { kind: 'qa', data: { phase: 'score', shotIndex: s.index, score, passed: true } },
  }));
  return [
    { at: 0, step: 'probe', message: '1080×1920 · 3:42' }, cost(10, 0),
    { at: 300, step: 'audio', message: '已抽取 16kHz 音频' },
    { at: 900, step: 'asr', message: '识别 1024 字 · 62 个语音段', detail: { kind: 'transcript', data: { lines: transcript() } } },
    { at: 1700, step: 'cuts', message: '标记 49 处气口/重复/口误', detail: { kind: 'cut', data: { cuts: CUTS.map(([from, to, type]) => ({ from, to, type })) } } },
    cost(1710, 0.56),
    { at: 1800, step: 'plan', message: '原片 3:42 → 成片 1:57' },
    { at: 2100, step: 'render', message: '剪切完成' }, { at: 2300, step: 'background', message: '背景：书房' },
    ...[20, 45, 70, 100].map((p, i) => pct(2600 + i * 600, 'matte', p)),
    { at: 5200, step: 'captions', message: '41 行字幕', detail: { kind: 'captions', data: { lines: captionLines() } } }, cost(5210, 0.74),
    { at: 6000, step: 'storyboard', message: '18 个镜头 · 12 张卡片', detail: { kind: 'shot', data: { shots: SHOTS } } }, cost(6010, 0.86),
    { at: 7000, step: 'broll', message: '素材 3 个（截图 2 / 生图 1 / 视频 0）' }, cost(7010, 1.06),
    ...qa,
    ...[25, 50, 75, 100].map((p, i) => pct(9000 + i * 700, 'compose', p)),
    { at: 12000, step: 'loudness', message: '响度 -18.6 → -14.0 LUFS' }, { at: 12300, step: 'qa-final', message: '成片检查：全部通过（7/7）' },
    { at: 12600, step: 'cover', message: '封面已生成' }, cost(12610, 3.84), { at: 12800, step: 'done', message: 'final.mp4' },
  ];
}

const editScript = (summary: string): Ev[] => [
  { at: 0, step: 'edit', message: `修改：${summary} · 应用 1 项修改 · 重跑：成片` }, cost(10, 0),
  ...[30, 60, 100].map((p, i) => pct(800 + i * 700, 'compose', p)),
  { at: 3200, step: 'qa-final', message: '成片检查：全部通过（7/7）' }, cost(3210, 0.16), { at: 3400, step: 'done', message: 'final.mp4' },
];

interface Hub { logs: Map<string, WorkEvent[]>; subs: Map<string, Set<EventSink>> }
const k = (id: string, n: number) => `${id}:${n}`;

function publish(hub: Hub, id: string, n: number, e: Omit<WorkEvent, 'seq' | 'spaceId' | 'version'>): void {
  const list = hub.logs.get(k(id, n)) ?? [];
  const ev: WorkEvent = { ...e, seq: list.length + 1, spaceId: id, version: n };
  hub.logs.set(k(id, n), [...list, ev]);
  hub.subs.get(k(id, n))?.forEach((fn) => fn(ev));
}

/** 已完成的种子版本：一次性写入历史（时间戳放在过去） */
function seedHistory(hub: Hub, id: string, n: number, script: Ev[]): void {
  const t0 = Date.now() - 86_400_000;
  script.forEach(({ at, ...e }) => publish(hub, id, n, { ...e, t: t0 + at * 4 }));
}

function play(hub: Hub, f: Find, id: string, meta: VersionMeta, script: Ev[]): void {
  const t0 = Date.now();
  script.forEach(({ at, ...e }) => window.setTimeout(() => {
    publish(hub, id, meta.n, { ...e, t: t0 + at });
    if (e.step !== 'done') return;
    const s = f.find(id);
    const first = isFirst(meta);
    const finished = { status: 'done' as const, changedShots: first ? [] : [4], costYuan: first ? 3.84 : 0.16, qaScore: first ? 8.8 : 9.0 };
    f.replace({ ...s, job: null, versions: s.versions.map((v) => (v.n === meta.n ? { ...v, ...finished } : v)) });
  }, at));
}

const STATE: VersionState = {
  storyboard: {
    shots: SHOTS.map((s) => ({
      start: s.start, end: s.end, layout: s.layout, ...(s.template ? { card: { template: s.template, props: { title: s.title } } } : {}),
    })),
  },
  captions: [],
  plan: { outputDurationSec: 117, sourceDurationSec: 222 },
};

export function withRuns(base: Api, f: Find, spaces: Space[]): Api {
  const hub: Hub = { logs: new Map(), subs: new Map() };
  spaces.forEach((s) => s.versions.forEach((v) => seedHistory(hub, s.id, v.n, isFirst(v) ? firstScript() : editScript(v.summary))));
  const enqueue = (id: string, summary: string, ops: EditOp[]): { version: number; queued: number } => {
    const s = f.find(id);
    if (s.job) throw new ApiError('这个项目已有任务在排队或运行', 409);
    const n = s.versions.reduce((m, v) => Math.max(m, v.n), 0) + 1;
    const meta: VersionMeta = { n, createdAt: new Date().toISOString(), parent: n - 1, summary, changedShots: [], costYuan: 0, status: 'running' };
    f.replace({ ...s, job: { state: 'running', version: n }, versions: [...s.versions, meta] });
    play(hub, f, id, meta, ops.length ? editScript(summary) : editScript(summary).slice(-2));
    return { version: n, queued: 0 };
  };
  return {
    ...base,
    async start(id) {
      const out = await base.start(id);
      const s = f.find(id);
      f.replace({ ...s, job: { state: 'running', version: out.version } });
      play(hub, f, id, s.versions.find((v) => v.n === out.version) as VersionMeta, firstScript());
      return out;
    },
    async messages(_id, message, version) {
      await new Promise((r) => setTimeout(r, 900));
      const card = (title: string) => [{ type: 'replaceCard', shotIndex: 4, card: { template: 'title', props: { title } } }];
      const reply = `明白${message.startsWith('@') ? '，就改你点的这张' : ''}，只重渲这 1 段，其余 17 段原样复用。标题想要哪种？`;
      const options = [{ label: '大字标题', ops: card('省下的都是赚到的') }, { label: '加一行副标题', ops: card('少花冤枉钱') }];
      return { reply, ops: [], options, version: version ?? 1 };
    },
    async apply(id, ops, _parent, summary) { return { ...enqueue(id, summary ?? '对话修改', ops), dropped: [] }; },
    async chat() { return { turns: [] }; },
    async revert(id, n) { return enqueue(id, `回退到 v${n}`, []); },
    async cancel() { /* 演示数据不支持取消 */ },
    async exportVersion(_id, n) { return { dir: '~/Downloads/明知AI剪辑', files: [`~/Downloads/明知AI剪辑/演示-v${n}.mp4`] }; },
    async versionState() { return STATE; },
    events(id, n, sink) {
      const key = k(id, n);
      (hub.logs.get(key) ?? []).forEach((e) => sink(e));
      const set = hub.subs.get(key) ?? new Set<EventSink>();
      set.add(sink);
      hub.subs.set(key, set);
      return () => { set.delete(sink); };
    },
  };
}
