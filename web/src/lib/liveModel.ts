/**
 * 剪辑直播的视图模型：把一个版本的事件序列（WorkEvent，见 src/pipeline/detail.ts）归并成界面要的样子。
 * 纯函数，实时、补历史与重播都走它：给前 k 条事件就得到第 k 刻的画面。
 */
import type { WorkEvent } from '../api';

export interface TxLine { from: number; start: number; end: number; text: string; tokens: string[] }
export interface CutMark { from: number; to: number; type: string }
/** 校对后的字幕行：覆盖的 token 下标区间 [from, to]（区间内可能夹着被剪的 token） */
export interface CapLine { from: number; to: number; text: string }
export interface ShotInfo { index: number; start: number; end: number; layout: 'split' | 'full'; template?: string; title?: string }
export interface StepLine { step: string; label: string; message: string; t0: number; t1?: number; pct?: number; state: 'run' | 'ok' | 'fail' }
export interface QaScore { layout: number; hierarchy: number; motion: number; brand: number }
export type LiveStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed';

export interface LiveView {
  status: LiveStatus;
  steps: StepLine[];
  transcript: TxLine[];
  cuts: CutMark[];
  /** 字幕校对完成后才有；有它时转录显示校对后的文字 */
  captions: CapLine[];
  shots: ShotInfo[];
  /** 各镜卡片的最新分数（按镜头序号） */
  qa: Record<number, QaScore>;
  cost?: { total: number; budget: number | null };
  sourceSec?: number;
  outputSec?: number;
  error?: string;
  t0?: number;
  t1?: number;
}

export const STEP_LABEL: Record<string, string> = {
  queued: '排队', probe: '探测', audio: '抽音频', asr: '识别', cuts: '剪口误', plan: '剪辑方案', render: '剪切', background: '背景',
  matte: '抠像', captions: '字幕', storyboard: '分镜', broll: '素材', 'qa-cards': '卡片自检', compose: '渲染', loudness: '响度',
  'qa-film': '整片自检', 'qa-final': '成片检查', cover: '封面', edit: '修改', done: '完成', failed: '失败',
};

export const EMPTY_LIVE: LiveView = { status: 'idle', steps: [], transcript: [], cuts: [], captions: [], shots: [], qa: {} };

/** 「m:ss」→ 秒 */
const secOf = (m: string, s: string): number => Number(m) * 60 + Number(s);

function durations(view: LiveView, e: WorkEvent): Pick<LiveView, 'sourceSec' | 'outputSec'> {
  const plan = /原片 (\d+):(\d{2}) → 成片 (\d+):(\d{2})/.exec(e.message);
  if (plan) return { sourceSec: secOf(plan[1], plan[2]), outputSec: secOf(plan[3], plan[4]) };
  const probe = e.step === 'probe' ? /(\d+):(\d{2})$/.exec(e.message) : null;
  if (probe) return { sourceSec: secOf(probe[1], probe[2]), outputSec: view.outputSec };
  return { sourceSec: view.sourceSec, outputSec: view.outputSec };
}

/** 明细并入视图（cost 明细不改步骤文字） */
function applyDetail(view: LiveView, e: WorkEvent): LiveView {
  const d = e.detail;
  if (!d) return view;
  const data = d.data as Record<string, unknown>;
  if (d.kind === 'cost') return { ...view, cost: { total: Number(data.total) || 0, budget: data.budget == null ? null : Number(data.budget) } };
  if (d.kind === 'transcript') return { ...view, transcript: (data.lines as TxLine[]) ?? [] };
  if (d.kind === 'cut') return { ...view, cuts: ((data.cuts as CutMark[]) ?? []).map(({ from, to, type }) => ({ from, to, type })) };
  if (d.kind === 'captions') return { ...view, captions: ((data.lines as CapLine[]) ?? []).map(({ from, to, text }) => ({ from, to, text })) };
  if (d.kind === 'shot') {
    const shots = (data.shots as ShotInfo[]) ?? [];
    const last = shots.at(-1);
    return { ...view, shots, outputSec: last ? last.end : view.outputSec };
  }
  if (d.kind === 'qa' && data.phase === 'score') return { ...view, qa: { ...view.qa, [Number(data.shotIndex)]: data.score as QaScore } };
  return view;
}

/** 步骤行：同名步骤只占一行（后来的事件更新它的文字与进度） */
function applyStep(steps: StepLine[], e: WorkEvent): StepLine[] {
  if (e.step === 'done' || e.step === 'queued') return steps;
  const isCost = e.detail?.kind === 'cost';
  const pct = e.detail?.kind === 'progress' ? Number((e.detail.data as { pct?: number }).pct) : undefined;
  const message = isCost ? undefined : e.message.split('\n')[0];
  const closed = steps.map((s) => (s.state === 'run' && s.step !== e.step ? { ...s, state: 'ok' as const, t1: s.t1 ?? e.t } : s));
  const at = closed.findIndex((s) => s.step === e.step);
  if (at < 0) {
    if (isCost && closed.length) return closed;
    const state = e.step === 'failed' ? 'fail' : 'run';
    return [...closed, { step: e.step, label: STEP_LABEL[e.step] ?? e.step, message: message ?? '', t0: e.t, ...(pct !== undefined ? { pct } : {}), state }];
  }
  const cur = closed[at];
  const next: StepLine = { ...cur, message: message ?? cur.message, ...(pct !== undefined ? { pct } : {}), state: 'run', t1: undefined };
  return closed.map((s, i) => (i === at ? next : s));
}

function statusOf(e: WorkEvent): LiveStatus {
  if (e.step === 'done') return 'done';
  if (e.step === 'failed') return 'failed';
  return e.step === 'queued' ? 'queued' : 'running';
}

export function reduceLive(events: readonly WorkEvent[]): LiveView {
  return events.reduce<LiveView>((view, e) => {
    const status = statusOf(e);
    const steps = status === 'done'
      ? view.steps.map((s) => (s.state === 'run' ? { ...s, state: 'ok' as const, t1: e.t } : s))
      : applyStep(view.steps, e);
    const detailed = applyDetail(view, e);
    return {
      ...detailed, ...durations(detailed, e), steps, status,
      t0: view.t0 ?? e.t, ...(status === 'done' || status === 'failed' ? { t1: e.t } : {}),
      ...(status === 'failed' ? { error: e.message } : {}),
    };
  }, EMPTY_LIVE);
}

/** 四维自检分：已打分卡片的平均 */
export function qaAverage(qa: Record<number, QaScore>): (QaScore & { count: number }) | undefined {
  const list = Object.values(qa);
  if (!list.length) return undefined;
  const avg = (k: keyof QaScore) => list.reduce((s, q) => s + q[k], 0) / list.length;
  return { layout: avg('layout'), hierarchy: avg('hierarchy'), motion: avg('motion'), brand: avg('brand'), count: list.length };
}

/** 剪掉的 token 下标集合 */
export const cutTokenSet = (cuts: CutMark[]): ReadonlySet<number> =>
  new Set(cuts.flatMap((c) => Array.from({ length: Math.max(0, c.to - c.from + 1) }, (_, i) => c.from + i)));

/** 语气词与口误分开计数 */
export const cutCounts = (cuts: CutMark[]): { filler: number; slip: number } => ({
  filler: cuts.filter((c) => c.type === 'filler').length,
  slip: cuts.filter((c) => c.type !== 'filler').length,
});
