import { writeFileSync } from 'node:fs';
import type { CostEntry } from '../cost/meter.js';
import type { BrollAsset } from '../broll/fulfill.js';
import type { BeatRecord } from './broll-beats.js';
import type { Transcript } from '../asr/types.js';
import type { CaptionLine, TimedCaption } from '../captions/lines.js';
import type { CaptionsSource } from '../captions/polish.js';
import type { Cut } from '../cut/llm-cuts.js';
import type { EditPlan } from '../cut/plan.js';
import type { BackgroundSpec } from '../background/resolve.js';
import type { SubjectBox } from '../matting/composite.js';
import type { MediaInfo } from '../media/probe.js';
import type { Storyboard } from '../storyboard/schema.js';
import type { Mood } from '../assets/catalog.js';
import type { CaptionStyleId } from '../captions/styles.js';
import type { CoverAspect } from '../cover/generate.js';
import type { CoverStyleId } from '../cover/styles.js';
import type { HardCheck } from '../qa/hard.js';
import type { CardQaEntry } from '../qa/visual.js';
import type { FilmQa } from '../qa/film-redo.js';

export interface ProjectArtifacts { wav?: string; cut?: string; person?: string; ass?: string; output?: string; final?: string; cover43?: string; cover34?: string }

/** 工程文件 project.json：每一步完成后增量落盘，尚未完成的步骤对应字段缺省；全部完成时字段齐全 */
export interface ProjectFile {
  version: 1;
  input: string;
  createdAt: string;
  media?: MediaInfo;
  transcript?: Transcript;
  cuts?: Cut[];
  plan?: EditPlan;
  /** 字幕行（按字下标），供后续编辑 */
  captionLines?: CaptionLine[];
  captionsSource?: CaptionsSource;
  /** 字幕行映射到成片时间轴后的结果 */
  captions?: TimedCaption[];
  /** 换背景：背景来源与落地的图片路径（P2） */
  background?: { spec: BackgroundSpec; path: string };
  /** 人物在画面中的范围（中位数，0–1），供 P3 取景；抠不出人时为 null */
  subject?: SubjectBox | null;
  /** 分镜（P3a）；请求失败时为整片一个全屏镜头 */
  storyboard?: Storyboard;
  /** 分镜里被丢弃的不合格镜头数 */
  storyboardDropped?: number;
  /** 分镜里因版式规则或短镜头合并而失去卡片的镜头数 */
  storyboardDemoted?: number;
  /** 分镜里因超过 8 秒被截短的带卡片镜头数 */
  storyboardCapped?: number;
  /** B-roll 素材获取结果（P3b）：取到的素材、失败的镜头与花费（元）；未开启时缺省 */
  broll?: { assets: BrollAsset[]; failures: { shotIndex: number; reason: string }[]; costYuan: number; /** 视觉节拍与各自结果（P7，重做单个镜头时读它） */ beats?: BeatRecord[]; /** 放好素材后的整片复检问题 */ issues?: string[] };
  /** 配乐与音效（P3c）：所选曲目 id（无配乐为 null）、情绪、触发的音效数 */
  audio?: { track: string | null; mood: Mood; sfxCount: number };
  /** 字幕样式（P3c） */
  captionStyle?: CaptionStyleId;
  /** 封面（P3c）：风格、花费（元）、标题核对未通过的比例、直接复用已有底图的比例；封面关闭或失败时缺省 */
  cover?: { style: CoverStyleId; costYuan: number; unverified: CoverAspect[]; reused: CoverAspect[] };
  /** 响度统一（P3c）：处理前后的综合响度（LUFS）；音轨静音无法归一时缺省 */
  loudness?: { before: number; after: number };
  /** 本次出片的实际花费（P4）：累计、预算上限（不限时为 null）与逐条账目 */
  costs?: { total: number; budget: number | null; entries: CostEntry[] };
  /** 自检（P4）：卡片视觉自检报告与成片硬检查；加 --no-qa 时缺省 */
  qa?: { cards: CardQaEntry[]; hard: HardCheck[] };
  /** 整片自检（P7）：静止、空白率、首帧、模板多样性、摄影级画面覆盖、素材复用、音效重复、铺图卡片可读性，以及局部重做与复测 */
  film?: FilmQa;
  artifacts: ProjectArtifacts;
}

export type ProjectPatch = Partial<Omit<ProjectFile, 'version' | 'input' | 'createdAt' | 'artifacts'>> & { artifacts?: ProjectArtifacts };

/** 返回一个记录函数：每次合并补丁生成新的工程对象并整份写盘，返回最新对象 */
export function projectRecorder(path: string, input: string): (patch: ProjectPatch) => ProjectFile {
  let current: ProjectFile = { version: 1, input, createdAt: new Date().toISOString(), artifacts: {} };
  return (patch) => {
    current = { ...current, ...patch, artifacts: { ...current.artifacts, ...patch.artifacts } };
    writeFileSync(path, JSON.stringify(current, null, 2));
    return current;
  };
}
