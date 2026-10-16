/**
 * 分镜多样性规则（审片报告第 6 节第 4 条）：同一模板连续 ≤ 2 个镜头（钩子除外）；evidenceList 合计 ≤ 20% 时长；
 * 任意 2 分钟内 ≥ 4 种呈现模式；「证据」「来源」徽章只给带数据或出处的行。
 * storyboardIssues 只检查不修改（供重试提示与整片自检）；applyStoryboardRules 按规则修正并列出修了什么（不改时间轴）
 */
import { HOOK_WINDOW_SEC, type CardSpec, type Shot, type TemplateId } from './schema.js';
import { visualLayout } from '../compose/layout.js';

export const MAX_SAME_RUN = 2;
export const EVIDENCE_MAX_RATIO = 0.2;
export const MODE_WINDOW_SEC = 120;
export const MIN_MODES = 4;
/** 短于这个时长的片子不检查呈现模式（十几秒的短片放不下 4 种） */
export const MIN_MODE_FILM_SEC = 60;

/** 呈现模式：人物全屏、文字卡、数据与图解、配图与实拍素材、网页截图、人物加浮层卡 */
export type Mode = 'person' | 'text' | 'graphic' | 'media' | 'screen' | 'overlay';
const MODE_NAME: Record<Mode, string> = { person: '人物全屏', text: '文字卡', graphic: '数据与图解', media: '配图或实拍', screen: '网页截图', overlay: '浮层卡' };
const GRAPHIC: readonly TemplateId[] = ['bigNumber', 'compareBars', 'flow'];
/** 能改成浮层的紧凑卡（浮层卡压在人物头顶，内容长的卡会遮脸） */
const FLOATABLE: readonly TemplateId[] = ['title', 'bigNumber', 'chips'];

const DIGIT = /[0-9０-９]|[一二两三四五六七八九十百千万亿几半]+\s*(成|倍|%|％|个百分点)/;
const SOURCE = /《[^》]+》|来源|出自|报告|论文|研究|调查|统计|期刊|官网|官方|白皮书|DOI|https?:|www\.|\.com|\.org|大学|研究院|年报|财报|试验|实验|GitHub/i;

/** 文字里有数据（数字、成数、倍数、百分比）或明确出处 */
export function hasEvidence(text: string): boolean {
  return DIGIT.test(text) || SOURCE.test(text);
}

const needsEvidence = (badge: string): boolean => badge === '证据' || badge === '来源';

/** 徽章语义：「证据」「来源」用在没有数据或出处的行上改成「要点」；没有要改的原样返回 */
export function fixBadges(card: CardSpec): CardSpec {
  if (card.template !== 'evidenceList' || !card.props.rows.some((r) => needsEvidence(r.badge) && !hasEvidence(r.text))) return card;
  const rows = card.props.rows.map((r) => (needsEvidence(r.badge) && !hasEvidence(r.text) ? { ...r, badge: '要点' as const } : r));
  return { template: 'evidenceList', props: { ...card.props, rows } };
}

const badBadges = (shots: Shot[]): string[] => shots.flatMap((s) => (s.card?.template === 'evidenceList'
  ? s.card.props.rows.filter((r) => needsEvidence(r.badge) && !hasEvidence(r.text)).map((r) => `徽章「${r.badge}」用在没有数据或出处的行上：「${r.text}」`)
  : []));

/** 镜头的呈现模式（按实际渲染的版式） */
export function shotMode(shot: Shot): Mode {
  const layout = visualLayout(shot);
  if (layout === 'overlay') return 'overlay';
  if (layout === 'broll' || layout === 'pip' || (layout === 'split' && shot.broll)) return 'media';
  const card = layout === 'split' ? shot.card : undefined;
  if (!card) return 'person';
  if (card.template === 'photo') return 'media';
  if (card.template === 'browser') return 'screen';
  if (card.template === 'hook') return card.props.image || card.props.video ? 'media' : card.props.stat ? 'graphic' : 'text';
  return GRAPHIC.includes(card.template) ? 'graphic' : 'text';
}

const fmt = (sec: number): string => sec.toFixed(1);
const tpl = (s: Shot): TemplateId | undefined => s.card?.template;
/** 参与「连续同模板」判断的模板（钩子按设计连用，cta 只在末尾） */
const runTemplate = (s: Shot): TemplateId | undefined => (tpl(s) === 'hook' || tpl(s) === 'cta' ? undefined : tpl(s));

/** 每个镜头所在同模板连续段的长度（到它为止）；无卡片或钩子为 0 */
function runLengths(shots: Shot[]): number[] {
  return shots.reduce<number[]>((acc, s, i) => {
    const t = runTemplate(s);
    return [...acc, t === undefined ? 0 : i > 0 && runTemplate(shots[i - 1]) === t ? acc[i - 1] + 1 : 1];
  }, []);
}

export const longestRun = (shots: Shot[]): number => Math.max(0, ...runLengths(shots));

function runIssues(shots: Shot[]): string[] {
  const lens = runLengths(shots);
  return lens.flatMap((n, i) => {
    const ends = n > MAX_SAME_RUN && (lens[i + 1] ?? 0) <= n;
    return ends ? [`同一模板连续 ${n} 个镜头（${tpl(shots[i])}，${fmt(shots[i - n + 1].start)}–${fmt(shots[i].end)} 秒），最多 ${MAX_SAME_RUN} 个`] : [];
  });
}

/** evidenceList 镜头合计时长占片长的比例 */
export function evidenceRatio(shots: Shot[], durationSec: number): number {
  return shots.filter((s) => tpl(s) === 'evidenceList').reduce((n, s) => n + s.end - s.start, 0) / durationSec;
}

export interface ModeWindow { start: number; end: number; modes: Mode[] }

/** 2 分钟滑动窗口（从各镜头起点开始，整片不足 2 分钟时取整片）里出现的呈现模式；短片不检查 */
export function modeWindows(shots: Shot[], durationSec: number): ModeWindow[] {
  if (durationSec < MIN_MODE_FILM_SEC) return [];
  const last = Math.max(0, durationSec - MODE_WINDOW_SEC);
  const starts = [...new Set(shots.map((s) => s.start).filter((t) => t <= last + 1e-9))];
  return starts.map((start) => {
    const end = Math.min(durationSec, start + MODE_WINDOW_SEC);
    const modes = [...new Set(shots.filter((s) => s.end > start && s.start < end).map(shotMode))];
    return { start, end, modes };
  });
}

const thinWindows = (shots: Shot[], durationSec: number): ModeWindow[] => modeWindows(shots, durationSec).filter((w) => w.modes.length < MIN_MODES);

/** 只检查、不修改：违反规则的地方（中文描述） */
export function storyboardIssues(shots: Shot[], durationSec: number): string[] {
  const ratio = evidenceRatio(shots, durationSec);
  const thin = thinWindows(shots, durationSec)[0];
  return [
    ...runIssues(shots),
    ...(ratio > EVIDENCE_MAX_RATIO + 1e-9 ? [`evidenceList 占 ${Math.round(ratio * 100)}% 时长，最多 ${EVIDENCE_MAX_RATIO * 100}%`] : []),
    ...(thin ? [`${fmt(thin.start)}–${fmt(thin.end)} 秒只有 ${thin.modes.length} 种呈现模式（${thin.modes.map((m) => MODE_NAME[m]).join('、')}），至少 ${MIN_MODES} 种`] : []),
    ...badBadges(shots),
  ];
}

// ---------- 修正 ----------

/** evidenceList → 标题卡：保留标题与面包屑，各行要点并成副标题（放不下时只取第一行） */
function evidenceToTitle(card: Extract<CardSpec, { template: 'evidenceList' }>): CardSpec {
  const joined = card.props.rows.map((r) => r.text).join(' · ');
  const subtitle = joined.length <= 60 ? joined : card.props.rows[0].text;
  return { template: 'title', props: { title: card.props.title, subtitle, ...(card.props.crumb ? { crumb: card.props.crumb } : {}) } };
}

const replaceAt = (shots: Shot[], i: number, shot: Shot): Shot[] => shots.map((s, k) => (k === i ? shot : s));
const demote = (s: Shot): Shot => ({ start: s.start, end: s.end, layout: 'full' });

/** 换掉第 i 个镜头的卡片：evidenceList 能转标题卡且不新造连续段就转，否则改为人物全屏 */
function breakAt(shots: Shot[], i: number): Shot[] {
  const s = shots[i];
  if (s.card?.template === 'evidenceList') {
    const converted = replaceAt(shots, i, { ...s, card: evidenceToTitle(s.card) });
    if (longestRunAround(converted, i) <= MAX_SAME_RUN) return converted;
  }
  return replaceAt(shots, i, demote(s));
}

/** 第 i 个镜头前后同模板连续段的总长 */
function longestRunAround(shots: Shot[], i: number): number {
  const t = runTemplate(shots[i]);
  if (t === undefined) return 0;
  const left = shots.slice(0, i).reverse().findIndex((s) => runTemplate(s) !== t);
  const right = shots.slice(i + 1).findIndex((s) => runTemplate(s) !== t);
  return (left < 0 ? i : left) + 1 + (right < 0 ? shots.length - i - 1 : right);
}

/** 同模板连续超过 2 个：从左到右把第 3 个换掉（镜头数有限，必然终止） */
function breakRuns(shots: Shot[]): Shot[] {
  const i = runLengths(shots).findIndex((n) => n > MAX_SAME_RUN);
  return i < 0 ? shots : breakRuns(breakAt(shots, i));
}

/** evidenceList 超过 20% 时长：优先转换处在连续段里的，其次最长的，转成标题卡 */
function limitEvidence(shots: Shot[], durationSec: number): Shot[] {
  if (evidenceRatio(shots, durationSec) <= EVIDENCE_MAX_RATIO + 1e-9) return shots;
  const lens = runLengths(shots);
  const inRun = (i: number): boolean => lens[i] > 1 || (lens[i + 1] ?? 0) > 1;
  const pick = shots.map((s, i) => i).filter((i) => tpl(shots[i]) === 'evidenceList')
    .sort((a, b) => Number(inRun(b)) - Number(inRun(a)) || (shots[b].end - shots[b].start) - (shots[a].end - shots[a].start))[0];
  const card = shots[pick].card as Extract<CardSpec, { template: 'evidenceList' }>;
  return limitEvidence(replaceAt(shots, pick, { ...shots[pick], card: evidenceToTitle(card) }), durationSec);
}

/** 呈现模式不足：窗口里还没有浮层时，把一张紧凑卡改成浮层（它原来的模式在窗口里另有镜头时才改，避免拆东墙补西墙） */
function addOverlay(shots: Shot[], durationSec: number): Shot[] {
  const thin = thinWindows(shots, durationSec).find((w) => !w.modes.includes('overlay'));
  if (!thin) return shots;
  const inWindow = (s: Shot): boolean => s.end > thin.start && s.start < thin.end;
  const modeCount = (m: Mode): number => shots.filter((s) => inWindow(s) && shotMode(s) === m).length;
  const pick = shots.map((s, i) => i).filter((i) => {
    const s = shots[i];
    return inWindow(s) && s.layout === 'split' && !s.broll && s.start >= HOOK_WINDOW_SEC && FLOATABLE.includes(tpl(s) as TemplateId) && modeCount(shotMode(s)) > 1;
  }).pop();
  return pick === undefined ? shots : replaceAt(shots, pick, { ...shots[pick], layout: 'overlay' });
}

/** 按规则修正分镜（不改入参，不改时间轴）；fixes 为修正前违反的规则（中文描述） */
export function applyStoryboardRules(shots: Shot[], durationSec: number): { shots: Shot[]; fixes: string[] } {
  const fixes = storyboardIssues(shots, durationSec);
  if (fixes.length === 0) return { shots, fixes };
  const badges = shots.map((s) => (s.card ? { ...s, card: fixBadges(s.card) } : s));
  const out = addOverlay(breakRuns(limitEvidence(breakRuns(badges), durationSec)), durationSec);
  return { shots: out, fixes };
}
