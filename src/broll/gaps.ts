import type { TimedCaption } from '../captions/lines.js';
import { rethrowIfBalance } from '../llm/errors.js';
import type { LlmClient } from '../llm/kexiang.js';
import { fixBeats, measureCoverage, type CoverageReport } from './plan-check.js';
import { BeatSchema, PLAN_MODEL, type Beat } from './plan.js';

const REAL_KINDS: readonly Beat['kind'][] = ['footage', 'photo', 'screenshot'];

const SYSTEM = `你是短视频口播的视觉导演。下面这些时间段超过 15 秒没有真实世界画面（实拍、实物照片、真实网页截图）。请为每个时间段补 1 个真实画面节拍：画面必须对应这段口播里的具体名词或动作（产品、机构、地点、物件、动作），不要主题氛围图。
输出严格 JSON：{"beats":[{"start":秒,"end":秒,"role":"illustrate|prove|locate|emote|define","kind":"footage|photo|screenshot","subject":"一句话画面","mustShow":[],"avoid":[],"queryEn":["2-5 个英文词，以实物名词开头"],"queryZh":["中文名词"],"mustShowEn":["mustShow 的英文名词"],"queryAlt":["同义或上位词"],"present":"broll-full|split|pip|overlay","shotSize":"ECU|CU|MS|WS","motion":"push-in|static"}]}
每个 beat 1.5-3.5 秒，必须落在对应时间段内；搜索词不要出现 hologram、robot、neon、glowing、全息、机器人、霓虹；不要编造口播里没有的机构或网址，不写 urlHint。`;

const captionsIn = (captions: TimedCaption[], g: { start: number; end: number }): string =>
  captions.filter((c) => c.end > g.start && c.start < g.end).map((c) => `[${c.start.toFixed(1)}-${c.end.toFixed(1)}] ${c.text}`).join('\n');

const overlaps = (a: Beat, b: Beat): boolean => a.start < b.end && b.start < a.end;

/** 新补的真实画面挤掉与它重叠的非真实 beat（chart、ui、generated）；与真实 beat 重叠的新 beat 不要 */
export function mergeGapBeats(beats: Beat[], added: Beat[]): Beat[] {
  const fresh = added.filter((n) => REAL_KINDS.includes(n.kind) && !beats.some((b) => REAL_KINDS.includes(b.kind) && overlaps(b, n)));
  const kept = beats.filter((b) => !fresh.some((n) => overlaps(b, n)));
  return [...kept, ...fresh].sort((a, b) => a.start - b.start);
}

export interface GapFill { beats: Beat[]; coverage: CoverageReport; added: number; error?: string }

/**
 * 真实画面缺口（> 15 秒没有实拍、实物或截图）：一次模型调用为每个缺口补 1 个真实画面 beat，按程序规则修正后并入。
 * 没有缺口不调用；模型失败保留原节拍并记下原因（余额不足原样抛出）
 */
export async function fillRealGaps(llm: LlmClient, captions: TimedCaption[], beats: Beat[], coverage: CoverageReport, durationSec: number): Promise<GapFill> {
  if (coverage.realGaps.length === 0) return { beats, coverage, added: 0 };
  const user = coverage.realGaps.map((g, i) => `时间段 ${i + 1}：${g.start.toFixed(1)}-${g.end.toFixed(1)} 秒\n${captionsIn(captions, g)}`).join('\n\n');
  try {
    const raw = await llm.chatJson({ model: PLAN_MODEL, system: SYSTEM, user, reasoningEffort: 'low', label: 'B-roll 补真实画面' });
    const items = (raw as { beats?: unknown } | null)?.beats;
    const parsed = (Array.isArray(items) ? items : []).flatMap((item) => { const p = BeatSchema.safeParse(item); return p.success ? [p.data] : []; });
    const inGap = parsed.filter((b) => coverage.realGaps.some((g) => b.start >= g.start - 0.5 && b.end <= g.end + 0.5));
    const merged = fixBeats(mergeGapBeats(beats, inGap), durationSec).beats;
    const added = merged.filter((b) => !beats.some((o) => o.start === b.start && o.subject === b.subject)).length;
    return { beats: merged, coverage: measureCoverage(merged, durationSec), added };
  } catch (err) {
    rethrowIfBalance(err);
    return { beats, coverage, added: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
