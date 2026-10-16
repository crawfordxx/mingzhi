import { z } from 'zod';
import type { TimedCaption } from '../captions/lines.js';
import type { LlmClient } from '../llm/kexiang.js';
import type { Storyboard } from '../storyboard/schema.js';
import { DEFAULT_AVOID, fixBeats, measureCoverage, MAX_FULL_SEC, MAX_REAL_GAP_SEC, MIN_BEAT_SEC, MIN_COVERAGE, type CoverageReport } from './plan-check.js';

export const PLAN_MODEL = 'google/gemini-3.5-flash';

const note = z.string().trim().min(1).max(80);
const query = z.string().trim().min(2).max(80);

/** 视觉节拍：一段时间里需要什么真实画面、搜什么、怎么呈现 */
export const BeatSchema = z.object({
  start: z.number().finite(),
  end: z.number().finite(),
  role: z.enum(['illustrate', 'prove', 'locate', 'emote', 'define']),
  kind: z.enum(['footage', 'photo', 'screenshot', 'chart', 'ui', 'generated']),
  subject: z.string().trim().min(2).max(120),
  mustShow: z.array(note).max(6),
  avoid: z.array(note).max(8),
  queryEn: z.array(query).min(1).max(3),
  queryZh: z.array(query).min(1).max(3),
  urlHint: z.string().trim().url().regex(/^https?:\/\//).optional(),
  present: z.enum(['broll-full', 'split', 'pip', 'overlay']),
  shotSize: z.enum(['ECU', 'CU', 'MS', 'WS']),
  motion: z.enum(['push-in', 'pan-left', 'pan-right', 'parallax', 'slowmo', 'static']),
});
export type Beat = z.infer<typeof BeatSchema>;

export interface BeatPlan { beats: Beat[]; dropped: number; coverage: CoverageReport }

const SYSTEM_PROMPT = `你是短视频口播的视觉导演。输入是成片时间轴上的字幕、分镜概要和总时长。请规划「视觉节拍表」：哪几段需要插入什么真实世界画面（B-roll）、去网上搜什么、怎么呈现。节拍表是后续联网找可商用素材（Pexels、Pixabay、Wikimedia Commons、官网截图）的依据。

输出严格的 JSON，不要任何多余文字：
{"beats":[{"start":秒,"end":秒,"role":"illustrate|prove|locate|emote|define","kind":"footage|photo|screenshot|chart|ui|generated","subject":"一句话描述画面里是什么","mustShow":["必须出现的元素"],"avoid":["不要出现的元素"],"queryEn":["英文搜索词"],"queryZh":["中文搜索词"],"urlHint":"可选，已知的官网或页面网址","present":"broll-full|split|pip|overlay","shotSize":"ECU|CU|MS|WS","motion":"push-in|pan-left|pan-right|parallax|slowmo|static"}]}

字段含义：
- role：illustrate 说明口播讲的东西，prove 给证据，locate 交代地点或机构，emote 制造情绪与呼吸，define 解释定义。
- kind：footage 实拍视频，photo 实物或场景照片，screenshot 官网、产品页、招聘页、论文等真实页面截图，chart 数据图表，ui 界面示意，generated 找不到实拍时才用的 AI 生成画面。
- present：broll-full 全屏插入（单次 ${MIN_BEAT_SEC}-${MAX_FULL_SEC} 秒），split 占上半屏，pip 画中画，overlay 叠在人物上。
- shotSize：ECU 大特写，CU 特写，MS 中景，WS 全景。motion：该画面的运动方式。

规划规则：
1. 优先口播里的具体名词：产品、机构、地点、人物身份、动作、数字、物件。「带进业务现场」要搜现场实拍，「写在合同里」要搜合同纸张微距，「某某官网」要给 screenshot 并填 urlHint；不要为主题氛围配图（未来感办公室、抽象数据流、笔记本加咖啡这类 stock 套路）。subject 必须具体到能直接去搜。
2. 抽象段落（定义、对比、原因、观点）B-roll 总时长至少占全片 ${Math.round(MIN_COVERAGE * 100)}%；每 ${MAX_REAL_GAP_SEC} 秒内至少有 1 个真实世界画面（kind 为 footage、photo 或 screenshot）。
3. 景别交替：不要连续两个 beat 用同一个 shotSize；role 也尽量交替。
4. 每个 beat 至少 ${MIN_BEAT_SEC} 秒；节奏上大约每 5-6 秒一个 beat（2 分钟的片约 20 个），split、pip、overlay 的 beat 可以停 3-6 秒，broll-full 只能 ${MIN_BEAT_SEC}-${MAX_FULL_SEC} 秒；所有 beat 加起来要达到全片的 ${Math.round(MIN_COVERAGE * 100)}% 以上，开头 3 秒也要有画面。beats 按时间顺序、互不重叠、都在 0 到总时长之内；开始与结束尽量对齐字幕边界。
5. queryEn 和 queryZh 各 1-3 个：queryEn 用于 Pexels、Pixabay、Wikimedia，写成图库里真有人拍的画面（主体 + 动作/场景，3-6 个英文词）；queryZh 用于中文检索，写具体名词。不要在搜索词里写口播抽象词。
6. avoid 写这个画面不要出现的东西，默认包含：${DEFAULT_AVOID.join('、')}，再按具体画面补充（如不可识别的人脸特写、带品牌 Logo 的画面）。
7. 口播里的机构、社区、产品、岗位名，能找到官方页面就用 screenshot 并填 urlHint（不确定网址时留空，写 queryZh 让程序去搜）；口播里的数字或对比用 chart，不要用实拍硬凑。
8. 不要编造口播里没有的数字、机构或网址；urlHint 只在你确定官方网址时填写，不确定就不填。`;

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

/** 逐项用 BeatSchema 校验，不合格的丢弃并计数 */
function parseBeats(raw: unknown): { beats: Beat[]; dropped: number } {
  const items = (raw as { beats?: unknown } | null)?.beats;
  if (!Array.isArray(items)) throw new Error('模型返回缺少 beats 数组');
  const parsed = items.map((item) => BeatSchema.safeParse(item));
  const beats = parsed.flatMap((p) => (p.success ? [p.data] : []));
  return { beats, dropped: parsed.length - beats.length };
}

/**
 * 让 Gemini 读字幕与分镜，规划与时间对齐的视觉节拍表；schema 不合格的项丢弃，越界、重叠、过短由程序修正；
 * 返回覆盖率与真实画面缺口，是否补由编排层决定。请求失败直接抛出
 */
export async function planBeats(client: LlmClient, captions: TimedCaption[], storyboard: Storyboard, durationSec: number): Promise<BeatPlan> {
  const raw = await client.chatJson({
    model: PLAN_MODEL, system: SYSTEM_PROMPT, user: buildUserMessage(captions, storyboard, durationSec), reasoningEffort: 'low', label: '视觉节拍',
  });
  const valid = parseBeats(raw);
  const fixed = fixBeats(valid.beats, durationSec);
  return { beats: fixed.beats, dropped: valid.dropped + fixed.dropped, coverage: measureCoverage(fixed.beats, durationSec) };
}
