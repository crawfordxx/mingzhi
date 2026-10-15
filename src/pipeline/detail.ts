import type { Token, Transcript } from '../asr/types.js';
import type { Cut } from '../cut/llm-cuts.js';
import type { HardCheck } from '../qa/hard.js';
import type { CardQaEntry, CardScore } from '../qa/visual.js';
import type { CardSpec, Storyboard } from '../storyboard/schema.js';
import type { ProjectFile, ProjectPatch } from './project.js';

/** 进度事件携带的结构化数据，供工作台「剪辑直播」画界面；kind 决定 data 的形状 */
export interface ProgressDetail {
  kind: 'transcript' | 'cut' | 'shot' | 'qa' | 'cost' | 'progress';
  data: unknown;
}

type Four = Pick<CardScore, 'layout' | 'hierarchy' | 'motion' | 'brand'>;

/** 识别稿单行最多字数：没有语音段信息或一口气说很久时避免出现巨型行 */
const MAX_LINE_CHARS = 30;
const SENTENCE_END = /[。！？!?]$/;

const four = (s: CardScore): Four => ({ layout: s.layout, hierarchy: s.hierarchy, motion: s.motion, brand: s.brand });

/** 逐字稿按语音段切行（再按句末标点与字数上限切开）；data: { lines: { start, end, text }[] } */
export function transcriptDetail(t: Transcript): ProgressDetail {
  const groups = new Map<number, Token[]>();
  for (const token of t.tokens) {
    const seg = t.segments.findIndex((s) => token.start < s.end);
    const key = seg < 0 ? t.segments.length : seg;
    groups.set(key, [...(groups.get(key) ?? []), token]);
  }
  const lines = [...groups.values()].flatMap(splitLines).map((tokens) => ({
    start: tokens[0].start, end: tokens[tokens.length - 1].end, text: tokens.map((x) => x.text).join(''),
  }));
  return { kind: 'transcript', data: { lines } };
}

function splitLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    current = [...current, token];
    if (SENTENCE_END.test(token.text) || current.length >= MAX_LINE_CHARS) {
      lines.push(current);
      current = [];
    }
  }
  return current.length > 0 ? [...lines, current] : lines;
}

/** 被剪掉的片段：起止时间（原片秒数）、原文、类型与原因；data: { cuts }。cuts 的下标越界时按可用字对齐 */
export function cutsDetail(cuts: Cut[], tokens: Token[]): ProgressDetail {
  const items = cuts.flatMap((c) => {
    const first = tokens[c.from];
    const last = tokens[c.to];
    if (!first || !last) return [];
    return [{ from: c.from, to: c.to, start: first.start, end: last.end, text: tokens.slice(c.from, c.to + 1).map((t) => t.text).join(''), type: c.type, reason: c.reason }];
  });
  return { kind: 'cut', data: { cuts: items } };
}

type Props = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : undefined);

/** 卡片给人看的标题：每个模板挑最像标题的那个字段 */
export function cardTitle(card: CardSpec): string | undefined {
  const p = card.props as Props;
  switch (card.template) {
    case 'hook': return str(p.headline);
    case 'bigNumber': return [`${str(p.value) ?? ''}${str(p.unit) ?? ''}`, str(p.label)].filter(Boolean).join(' ') || undefined;
    case 'chips': return str((first(p.groups) as Props | undefined)?.label);
    case 'compareBars': return str((first(p.items) as Props | undefined)?.name);
    case 'terminal': return str(p.title) ?? str(first(p.lines));
    case 'toggles': return str(p.title) ?? str((first(p.rows) as Props | undefined)?.label);
    case 'strikeList': return str(p.title) ?? str(first(p.items));
    case 'browser': return str(p.title) ?? str(p.url);
    case 'photo': return str(p.label) ?? str(p.sublabel);
    case 'cta': return Array.isArray(p.actions) ? p.actions.filter((a) => typeof a === 'string').join(' / ') || undefined : undefined;
    default: return str(p.title);
  }
}

/** 分镜里每个镜头：序号、起止（成片秒数）、版式、模板名与标题；data: { shots } */
export function shotsDetail(storyboard: Storyboard): ProgressDetail {
  const shots = storyboard.shots.map((s, index) => {
    const title = s.card ? cardTitle(s.card) : undefined;
    return { index, start: s.start, end: s.end, layout: s.layout, ...(s.card ? { template: s.card.template } : {}), ...(title ? { title } : {}) };
  });
  return { kind: 'shot', data: { shots } };
}

/** 卡片自检的一次打分（边检查边发，分数一张张跳出）；data: { phase: 'score', shotIndex, score, passed } */
export function cardScoreDetail(shotIndex: number, score: CardScore, passed: boolean): ProgressDetail {
  return { kind: 'qa', data: { phase: 'score', shotIndex, score: four(score), passed } };
}

/** 卡片自检汇总：每张卡片取最后一次分数；data: { phase: 'cards', cards } */
export function cardsDetail(report: CardQaEntry[]): ProgressDetail {
  const cards = report.map((e) => {
    const last = e.scores[e.scores.length - 1];
    return { shotIndex: e.shotIndex, ...(last ? { score: four(last) } : {}), revised: e.revised, passed: e.passed, ...(e.skipped ? { skipped: e.skipped } : {}) };
  });
  return { kind: 'qa', data: { phase: 'cards', cards } };
}

/** 成片硬检查结果；data: { phase: 'hard', ok, checks } */
export function hardDetail(hard: HardCheck[]): ProgressDetail {
  return { kind: 'qa', data: { phase: 'hard', ok: hard.every((c) => c.ok), checks: hard.map((c) => ({ id: c.id, ok: c.ok, detail: c.detail })) } };
}

/** 当前总花费与上限（元）；不限预算时 budget 为 null */
export function costDetail(total: number, budget: number | null): ProgressDetail {
  return { kind: 'cost', data: { total, budget } };
}

/** 抠像 / 渲染百分比；抠像另带帧数 */
export function progressDetail(stage: 'matte' | 'compose', pct: number, frames?: { done: number; total: number }): ProgressDetail {
  return { kind: 'progress', data: { stage, pct, ...frames } };
}

/** 某一步完成时该带的明细：从这一步写入的 patch（和已落盘的 project）里取，没有就不带 */
export function detailOfStep(step: string, patch: ProjectPatch, project: ProjectFile): ProgressDetail | undefined {
  if (step === 'asr' && patch.transcript) return transcriptDetail(patch.transcript);
  if (step === 'cuts' && patch.cuts && project.transcript) return cutsDetail(patch.cuts, project.transcript.tokens);
  if (step === 'storyboard' && patch.storyboard) return shotsDetail(patch.storyboard);
  if (step === 'qa-cards' && patch.qa && patch.qa.cards.length > 0) return cardsDetail(patch.qa.cards);
  if (step === 'qa-final' && patch.qa && patch.qa.hard.length > 0) return hardDetail(patch.qa.hard);
  return undefined;
}
