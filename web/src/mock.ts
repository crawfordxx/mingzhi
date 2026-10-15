/**
 * 开发用假数据层（?mock=1 或 VITE_MOCK=1）：内存里模拟 Task 6 的接口（形状与 task-6-report.md 一致），带一点网络延迟。
 * 语义与真实服务对齐：background:null 才清除、undefined 键忽略；没有口播时 estimate 400；只收视频。
 * 参数：key=1 视为已配置 key；inputs=N 预置 N 段口播。图片只用油画、预设背景与封面示例，不含真人照片。
 * 字幕样式预览图由后端渲染（Task 6），这里 preview 留空，界面用 CSS 文字样式占位。
 */
import type { Api, Estimate, KeyInfo, Options, SettingsPatch, Space, SpaceSettings, Status, UploadOpts } from './api';
import { ApiError } from './api';
import { probeDuration } from './lib/media';
import { withRuns } from './mock-runs';

const BACKGROUNDS: [string, string, string][] = [
  ['study', '书房', '01-study'], ['studio', '极简工作室', '02-studio'], ['cafe', '咖啡馆', '03-cafe'],
  ['night-window', '夜景落地窗', '04-night-window'], ['tech-dark', '科技暗色', '05-tech-dark'], ['japanese', '日式和室', '06-japanese'],
  ['balcony', '绿植阳台', '07-balcony'], ['library', '图书馆', '08-library'], ['rooftop', '黄昏天台', '09-rooftop'], ['concrete', '水泥灰墙', '10-concrete'],
];
const CAPTIONS: [string, string][] = [['blade', '刀锋'], ['wenkai', '文楷'], ['smiley', '得意'], ['minimal', '简约'], ['kuaile', '快乐'], ['song', '宋韵']];
const COVERS: [string, string][] = [
  ['bauhaus', '包豪斯'], ['swiss', '瑞士国际主义'], ['memphis', '孟菲斯'], ['editorial', '杂志极简'], ['neon', '赛博霓虹'],
  ['guochao', '国潮'], ['risograph', '孔版印刷'], ['neobrutal', '新粗野主义'], ['y2k', '千禧 Y2K'], ['japanese', '日系清新'],
];

const OPTIONS: Options = {
  backgrounds: BACKGROUNDS.map(([id, name, file]) => ({ id, name, thumb: `/mock/${file}.webp` })),
  captionStyles: CAPTIONS.map(([id, name]) => ({ id, name, preview: '' })),
  coverStyles: COVERS.map(([id, name]) => ({ id, name, example: `/covers/${id}.webp` })),
  defaults: { captionStyle: 'blade', coverStyle: 'bauhaus', budgetYuan: 10, broll: true, maxVideos: 1 },
};

const DEFAULTS: SpaceSettings = { captionStyle: 'blade', coverStyle: 'bauhaus', budgetYuan: 10, broll: true, maxVideos: 1, background: { kind: 'preset', id: 'study' } };

const day = (offset: number): string => new Date(Date.UTC(2026, 9, 15 - offset, 13, 4)).toISOString();

function seedSpaces(inputs: number): Space[] {
  const done = (n: number, costYuan: number, summary: string, qaScore: number) =>
    ({ n, createdAt: day(1), summary, changedShots: [], costYuan, qaScore, status: 'done' as const });
  return [
    { id: 'ep3', title: '第 3 期', createdAt: day(0), inputs: Array.from({ length: inputs }, (_, i) => `第3期_口播_${i + 1}.mov`), versions: [], settings: DEFAULTS, job: null, totalCostYuan: 0 },
    { id: 'ep2', title: '第 2 期 · 高性价比人生指南', createdAt: day(1), inputs: ['第2期_口播.mov'], versions: [done(1, 3.84, '首版', 8.8), done(2, 0.16, '只重渲了 2 段', 9.0)], settings: { ...DEFAULTS, background: { kind: 'preset', id: 'night-window' } }, job: null, totalCostYuan: 4 },
    { id: 'ep1', title: '第 1 期', createdAt: day(9), inputs: ['第1期_口播.mov'], versions: [done(1, 2.95, '首版', 8.6)], settings: DEFAULTS, job: null, totalCostYuan: 2.95 },
  ];
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T,>(v: T): T => structuredClone(v);
const r2 = (v: number) => Math.round(v * 100) / 100;

/** 与 src/cost/estimate.ts 同一套公式的简化版，只为演示数字随设置变化 */
function mockEstimate(sec: number, s: SpaceSettings): Estimate {
  const min = sec / 60;
  const item = (label: string, low: number, high: number) => ({ label, low: r2(low), yuan: r2(high) });
  const items = [
    item('剪口误', min * 0.15, min * 0.15),
    item('字幕校对', min * 0.05, min * 0.05),
    item('分镜', min * 0.05, min * 0.05),
    ...(s.background?.kind === 'prompt' ? [item('背景生图', 0.2, 0.2)] : []),
    ...(s.broll ? [item('B-roll 生图', Math.ceil(sec / 15) * 0.2, Math.ceil(sec / 10) * 0.2), item('B-roll 视频（Seedance）', 0, s.maxVideos * 2.4)] : []),
    item('封面', 1.25, 2.5),
  ];
  return { low: r2(items.reduce((a, i) => a + i.low, 0)), high: r2(items.reduce((a, i) => a + i.yuan, 0)), items, durationSec: Math.round(sec), budgetYuan: s.budgetYuan };
}

/** 假服务的内存状态（相当于后端的数据目录） */
interface MockState { keyConfigured: boolean; spaces: Space[]; durations: Map<string, number> }

const VIDEO_RE = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;

/** 模拟流式上传：可被 signal 中止 */
async function fakeUpload({ onProgress, signal }: UploadOpts = {}): Promise<void> {
  for (let i = 1; i <= 16; i += 1) {
    if (signal?.aborted) throw new ApiError('已取消', 0);
    await wait(90);
    onProgress?.(i / 16);
  }
  if (signal?.aborted) throw new ApiError('已取消', 0);
}

/** PATCH 语义：undefined 键不改，background:null 删键 */
function applyPatch(settings: SpaceSettings, patch: SettingsPatch = {}): SpaceSettings {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as SettingsPatch;
  const { background, ...rest } = { ...settings, ...defined };
  return background === null || background === undefined ? rest : { ...rest, background };
}

function keyMethods(st: MockState): Pick<Api, 'status' | 'options' | 'getKey' | 'saveKey' | 'deleteKey'> {
  const keyInfo = (): KeyInfo => (st.keyConfigured ? { configured: true, source: 'keychain', masked: 'sk-…7f3a' } : { configured: false });
  return {
    async status(): Promise<Status> { await wait(80); return { version: '0.1.0', keyConfigured: st.keyConfigured, modelsReady: true, assetsReady: true, ffmpegReady: true }; },
    async options() { await wait(60); return clone(OPTIONS); },
    async getKey() { await wait(60); return keyInfo(); },
    async saveKey(key) {
      await wait(900);
      if (!/^sk-[A-Za-z0-9]{16,}$/.test(key.trim())) throw new ApiError('key 无效：可想 AI 拒绝了这个 key', 400);
      st.keyConfigured = true;
      return keyInfo();
    },
    async deleteKey() { await wait(100); st.keyConfigured = false; },
  };
}

type Finder = { find: (id: string) => Space; replace: (next: Space) => Space };

function finder(st: MockState): Finder {
  return {
    find: (id) => {
      const s = st.spaces.find((x) => x.id === id);
      if (!s) throw new ApiError(`项目不存在：${id}`, 404);
      return s;
    },
    replace: (next) => { st.spaces = st.spaces.map((s) => (s.id === next.id ? next : s)); return clone(next); },
  };
}

function crudMethods(st: MockState, { find, replace }: Finder): Pick<Api, 'listSpaces' | 'createSpace' | 'getSpace' | 'patchSpace' | 'deleteInput'> {
  return {
    async listSpaces() { await wait(120); return clone(st.spaces); },
    async createSpace(title) {
      await wait(120);
      const space: Space = { id: `new${Date.now().toString(36)}`, title: title ?? '未命名项目', createdAt: new Date().toISOString(), inputs: [], versions: [], settings: DEFAULTS, job: null, totalCostYuan: 0 };
      st.spaces = [space, ...st.spaces];
      return clone(space);
    },
    async getSpace(id) { await wait(80); return clone(find(id)); },
    async patchSpace(id, patch) {
      await wait(90);
      const s = find(id);
      return replace({ ...s, ...(patch.title ? { title: patch.title } : {}), settings: applyPatch(s.settings, patch.settings) });
    },
    async deleteInput(id, index) {
      await wait(120);
      const s = find(id);
      if (!(index >= 0 && index < s.inputs.length)) throw new ApiError('没有这段口播', 404);
      return replace({ ...s, inputs: s.inputs.filter((_, i) => i !== index) });
    },
  };
}

function mediaMethods(st: MockState, { find, replace }: Finder): Pick<Api, 'uploadInput' | 'uploadBackground' | 'estimate' | 'start'> {
  return {
    async uploadInput(id, file, opts) {
      if (!VIDEO_RE.test(file.name)) throw new ApiError('不是可识别的视频', 400);
      await fakeUpload(opts);
      const durationSec = (await probeDuration(file)) ?? 120;
      st.durations.set(file.name, durationSec);
      const next = replace({ ...find(id), inputs: [...find(id).inputs, file.name] });
      return { ...next, uploaded: { name: file.name, bytes: file.size, durationSec, width: 1080, height: 1920 } };
    },
    async uploadBackground(id, file, opts) {
      await fakeUpload(opts);
      const s = find(id);
      return replace({ ...s, settings: { ...s.settings, background: { kind: 'file', path: file.name } } });
    },
    async estimate(id) {
      await wait(160);
      const s = find(id);
      if (!s.inputs.length) throw new ApiError('还没有口播', 400);
      return mockEstimate(s.inputs.reduce((a, name) => a + (st.durations.get(name) ?? 120), 0), s.settings);
    },
    async start(id) {
      await wait(300);
      const s = find(id);
      if (!st.keyConfigured) throw new ApiError('还没有配置可想 AI key', 400);
      if (!s.inputs.length) throw new ApiError('先上传至少一段口播', 400);
      if (s.versions.length) throw new ApiError('已经出过片了', 409);
      replace({ ...s, job: { state: 'queued', version: 1 }, versions: [{ n: 1, createdAt: new Date().toISOString(), summary: '首版', changedShots: [], costYuan: 0, status: 'running' }] });
      return { version: 1, queued: 0 };
    },
  };
}

export function createMockApi(params: URLSearchParams): Api {
  const preset = Number(params.get('inputs') ?? 0);
  const spaces = seedSpaces(Number.isFinite(preset) ? preset : 0);
  const st: MockState = { keyConfigured: params.get('key') === '1', spaces, durations: new Map(spaces[0].inputs.map((name, i) => [name, [222, 96, 140][i % 3]])) };
  const f = finder(st);
  const base = { ...keyMethods(st), ...crudMethods(st, f), ...mediaMethods(st, f) } as Api;
  return withRuns(base, f, spaces);
}
