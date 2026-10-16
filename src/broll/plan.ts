import { z } from 'zod';
import type { TimedCaption } from '../captions/lines.js';
import { rethrowIfBalance } from '../llm/errors.js';
import type { LlmClient } from '../llm/kexiang.js';
import type { Storyboard } from '../storyboard/schema.js';
import { DEFAULT_AVOID, fixBeats, measureCoverage, MAX_BEAT_SEC, MAX_FULL_SEC, MAX_REAL_GAP_SEC, MIN_BEAT_SEC, MIN_COVERAGE, type CoverageReport } from './plan-check.js';
import { MAX_SPLIT_RATIO, presentTargets } from './plan-present.js';

export const PLAN_MODEL = 'google/gemini-3.5-flash';

/** 模型偶尔写超长：截断而不是整条丢弃；空串与多余项去掉 */
const list = (maxItems: number, maxLen: number) => z.array(z.string()).transform((a) => a.map((x) => x.trim().slice(0, maxLen)).filter(Boolean).slice(0, maxItems));
/** chart、ui 是自绘或界面示意，不需要搜索词；其余类型中英文搜索词至少各 1 个 */
const NO_QUERY_KINDS = ['chart', 'ui'];

/** 视觉节拍：一段时间里需要什么真实画面、搜什么、怎么呈现 */
export const BeatSchema = z.object({
  start: z.number().finite(),
  end: z.number().finite(),
  role: z.enum(['illustrate', 'prove', 'locate', 'emote', 'define']),
  kind: z.enum(['footage', 'photo', 'screenshot', 'chart', 'ui', 'generated']),
  subject: z.string().trim().min(2).transform((x) => x.slice(0, 120)),
  mustShow: list(6, 80),
  avoid: list(8, 80),
  queryEn: list(3, 80),
  queryZh: list(3, 80),
  /** 模型凭记忆给出的网址（空串、null、非法网址都当作没写），未经核实：编排层必须先联网核实（web_search 或请求确认）才能截图、写入 credits */
  urlHint: z.string().trim().url().regex(/^https?:\/\//).optional().catch(undefined),
  /** 有 urlHint 时程序一律标为 true（模型无法联网，网址只是记忆），下游看到它就要先核实 */
  urlHintUnverified: z.literal(true).optional(),
  present: z.enum(['broll-full', 'split', 'pip', 'overlay']),
  shotSize: z.enum(['ECU', 'CU', 'MS', 'WS']),
  motion: z.enum(['push-in', 'pan-left', 'pan-right', 'parallax', 'slowmo', 'static']),
}).refine((b) => NO_QUERY_KINDS.includes(b.kind) || (b.queryEn.length > 0 && b.queryZh.length > 0), { message: '实拍、截图、生图类 beat 需要中英文搜索词各至少 1 个', path: ['queryEn'] });
export type Beat = z.infer<typeof BeatSchema>;

export interface BeatPlan { beats: Beat[]; dropped: number; coverage: CoverageReport; attempts: number; retryError?: string }

const SYSTEM_PROMPT = `你是短视频口播的视觉导演。输入是成片时间轴上的字幕、分镜概要和总时长。请规划「视觉节拍表」：哪几段需要插入什么真实世界画面（B-roll）、去网上搜什么、怎么呈现。节拍表是后续联网找可商用素材（Pexels、Pixabay、Wikimedia Commons、官网截图）的依据。

输出严格的 JSON，不要任何多余文字：
{"beats":[{"start":秒,"end":秒,"role":"illustrate|prove|locate|emote|define","kind":"footage|photo|screenshot|chart|ui|generated","subject":"一句话描述画面里是什么","mustShow":["必须出现的元素"],"avoid":["不要出现的元素"],"queryEn":["英文搜索词"],"queryZh":["中文搜索词"],"urlHint":"可选，口播明确提到的官网网址","present":"broll-full|split|pip|overlay","shotSize":"ECU|CU|MS|WS","motion":"push-in|pan-left|pan-right|parallax|slowmo|static"}]}

字段含义：
- role：illustrate 说明口播讲的东西，prove 给证据，locate 交代地点或机构，emote 制造情绪与呼吸，define 解释定义。
- kind：footage 实拍视频，photo 实物或场景照片，screenshot 官网、产品页、招聘页、论文等真实页面截图，chart 数据图表，ui 界面示意，generated 找不到实拍时才用的 AI 生成画面。
- shotSize：ECU 大特写，CU 特写，MS 中景，WS 全景。motion：该画面的运动方式。
- present 怎么选：
  - broll-full 全屏插入，单次 ${MIN_BEAT_SEC}-${MAX_FULL_SEC} 秒，给具体名词和动作（现场、实物、操作、地点），画面本身就是信息；
  - split 占上半屏，给数据、对比、需要和人物同屏的辅助画面；
  - pip 画中画，给需要讲解的网页截图、界面和流程；
  - overlay 叠在人物上，给情绪、总结、一笔带过的氛围。

规划规则：
1. 优先口播里的具体名词：产品、机构、地点、人物身份、动作、数字、物件。「带进业务现场」要搜现场实拍，「写在合同里」要搜合同纸张微距；不要为主题氛围配图（未来感办公室、抽象数据流、笔记本加咖啡这类 stock 套路）。subject 必须具体到能直接去搜。
2. 抽象段落（定义、对比、原因、观点）B-roll 总时长至少占全片 ${Math.round(MIN_COVERAGE * 100)}%；每 ${MAX_REAL_GAP_SEC} 秒内至少有 1 个真实世界画面（kind 为 footage、photo 或 screenshot，chart、ui 不算）。
3. 景别交替：不要连续两个 beat 用同一个 shotSize；role 也尽量交替。
4. present 的分布：每 30 秒至少 1 个 broll-full（2 分钟的片至少 4 个），pip 与 overlay 合计每 60 秒至少 1 个（2 分钟至少 2 个），split 不超过全部 beat 的 ${MAX_SPLIT_RATIO * 100}%。按上面「present 怎么选」的内容类型分配，不要全写 split。
5. 每个 beat 至少 ${MIN_BEAT_SEC} 秒；节奏上大约每 5-6 秒一个 beat（2 分钟的片约 20 个）；broll-full 只能 ${MIN_BEAT_SEC}-${MAX_FULL_SEC} 秒，其他呈现最长 ${MAX_BEAT_SEC} 秒；所有 beat 加起来要达到全片的 ${Math.round(MIN_COVERAGE * 100)}% 以上，开头 3 秒也要有画面。beats 按时间顺序、互不重叠、都在 0 到总时长之内；开始与结束尽量对齐字幕边界。
6. queryEn 和 queryZh 各 1-3 个（chart、ui 可以留空数组）：queryEn 用于 Pexels、Pixabay、Wikimedia，写成图库里真有人拍的画面（主体 + 动作/场景，3-6 个英文词）；queryZh 用于中文检索，写具体名词。不要在搜索词里写口播抽象词，也不要出现 hologram、robot、neon、glowing、全息、机器人、霓虹。
7. avoid 写这个画面不要出现的东西，默认包含：${DEFAULT_AVOID.join('、')}，再按具体画面补充（如不可识别的人脸特写、带品牌 Logo 的画面）。
8. 口播里的机构、社区、产品、岗位名，想要真实页面就用 screenshot，把名字写进 queryZh，由程序联网去找页面。urlHint 只有口播里明确提到该机构或产品、且你确定它的官网时才写，否则一律留空；你没有联网能力，不要凭记忆补口播里没出现的机构网址。口播里的数字或对比用 chart，不要用实拍硬凑。
9. 不要编造口播里没有的数字、机构或网址。`;

const formatCaptions = (captions: TimedCaption[]): string =>
  captions.map((c) => `[${c.start.toFixed(2)}-${c.end.toFixed(2)}] ${c.text}`).join('\n');

/** 卡片里最能代表这一镜头内容的字段（标题类） */
const CARD_TEXT_KEYS = ['headline', 'title', 'label', 'value', 'url'] as const;

function cardText(props: unknown): string {
  const record = (props ?? {}) as Record<string, unknown>;
  const key = CARD_TEXT_KEYS.find((k) => typeof record[k] === 'string');
  return key ? String(record[key]) : '';
}

function formatStoryboard(storyboard: Storyboard): string {
  return storyboard.shots.map((s) => {
    const card = s.card ? `${s.card.template} ${cardText(s.card.props)}`.trim() : '人物';
    return `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.layout} ${card}`;
  }).join('\n');
}

const buildUserMessage = (captions: TimedCaption[], storyboard: Storyboard, durationSec: number): string =>
  `总时长：${durationSec.toFixed(2)} 秒\n字幕：\n${formatCaptions(captions)}\n分镜概要：\n${formatStoryboard(storyboard)}`;

interface Parsed { beats: Beat[]; dropped: number; errors: string[] }

const MAX_ERROR_SAMPLES = 3;
const MAX_DROPPED_RATIO = 0.3;

/** 逐项用 BeatSchema 校验，不合格的丢弃并计数，前几个错误留作重试提示 */
function parseBeats(raw: unknown): Parsed {
  const items = (raw as { beats?: unknown } | null)?.beats;
  if (!Array.isArray(items)) throw new Error('模型返回缺少 beats 数组');
  const parsed = items.map((item) => BeatSchema.safeParse(item));
  const beats = parsed.flatMap((p) => (p.success ? [p.data] : []));
  const errors = parsed.flatMap((p, i) => (p.success ? [] : [`第 ${i + 1} 个 beat ${p.error.issues[0].path.join('.') || '(根)'}：${p.error.issues[0].message}`]));
  return { beats, dropped: parsed.length - beats.length, errors: errors.slice(0, MAX_ERROR_SAMPLES) };
}

interface Attempt extends BeatPlan { total: number; errors: string[] }

const failedChecks = (c: CoverageReport): number => [c.coverageOk, c.realOk, c.presentOk].filter((ok) => !ok).length;

/** 需要重试：没有可用 beat、覆盖率/真实画面/呈现分布任一不达标，或不合格项过多 */
const needsRetry = (a: Attempt): boolean =>
  a.beats.length === 0 || failedChecks(a.coverage) > 0 || a.dropped > a.total * MAX_DROPPED_RATIO;

/** 更好的一次：不达标项更少；相同则丢弃更少；仍相同保留首次 */
const better = (a: Attempt, b: Attempt): Attempt => {
  const [fa, fb] = [failedChecks(a.coverage), failedChecks(b.coverage)];
  return fb < fa || (fb === fa && b.dropped < a.dropped) ? b : a;
};

const fmtGap = (g: { start: number; end: number }): string => `${g.start.toFixed(1)}-${g.end.toFixed(1)} 秒`;

/** 重试提示：带上上一次具体差在哪里（缺口时间段、覆盖率现值、分布不足、不合格项的错误） */
function retryHint(a: Attempt, durationSec: number): string {
  const { coverage } = a;
  const parts = [
    ...(a.beats.length === 0 ? [`上一次没有可用的 beat（${a.dropped} 个不合格${a.errors.length > 0 ? `：${a.errors.join('；')}` : ''}）`] : []),
    ...(a.beats.length > 0 && a.dropped > a.total * MAX_DROPPED_RATIO ? [`上一次有 ${a.dropped} 个 beat 不合格：${a.errors.join('；')}`] : []),
    ...(coverage.coverageOk ? [] : [`B-roll 总时长只占全片 ${(coverage.ratio * 100).toFixed(0)}%，需要至少 ${MIN_COVERAGE * 100}%，请增加 beat 并拉长非全屏的 beat`]),
    ...(coverage.realOk ? [] : [`这些时间段超过 ${MAX_REAL_GAP_SEC} 秒没有真实画面（footage、photo、screenshot）：${coverage.realGaps.map(fmtGap).join('、')}，请在其中补 beat`]),
    ...coverage.presentIssues,
  ];
  const targets = presentTargets(durationSec);
  return `\n\n上一次的问题：${parts.join('。')}。请补全后重新输出完整的 beats（broll-full 至少 ${targets.minFull} 个）。`;
}

/**
 * 让 Gemini 读字幕与分镜，规划与时间对齐的视觉节拍表；schema 不合格的项丢弃，越界、重叠、过短由程序修正，
 * 景别与呈现方式分布由程序兜底。覆盖率、真实画面节奏、呈现分布不达标或 beat 全丢时，带原因重试 1 次并保留更好的一次
 * （重试失败保留首次；余额不足原样抛出）。首次请求失败直接抛出。返回的 coverage 里仍不达标的项由编排层决定是否补
 */
export async function planBeats(client: LlmClient, captions: TimedCaption[], storyboard: Storyboard, durationSec: number): Promise<BeatPlan> {
  const user = buildUserMessage(captions, storyboard, durationSec);
  const attempt = async (message: string): Promise<Attempt> => {
    const raw = await client.chatJson({ model: PLAN_MODEL, system: SYSTEM_PROMPT, user: message, reasoningEffort: 'low', label: '视觉节拍' });
    const valid = parseBeats(raw);
    const fixed = fixBeats(valid.beats, durationSec);
    return { beats: fixed.beats, dropped: valid.dropped + fixed.dropped, total: valid.beats.length + valid.dropped, errors: valid.errors, coverage: measureCoverage(fixed.beats, durationSec), attempts: 1 };
  };
  const first = await attempt(user);
  if (!needsRetry(first)) return publicPlan(first);
  try {
    const second = await attempt(user + retryHint(first, durationSec));
    return publicPlan({ ...better(first, second), attempts: 2 });
  } catch (err) {
    rethrowIfBalance(err);
    return publicPlan({ ...first, attempts: 2, retryError: err instanceof Error ? err.message : String(err) });
  }
}

const publicPlan = ({ beats, dropped, coverage, attempts, retryError }: Attempt): BeatPlan => ({ beats, dropped, coverage, attempts, ...(retryError ? { retryError } : {}) });
