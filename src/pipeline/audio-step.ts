import { basename } from 'node:path';
import type { AppConfig } from '../config.js';
import { downloadedTracks, loadTracks, musicReady, type Track } from '../assets/catalog.js';
import { bgmEnvelope, pickTrack, sfxCues } from '../audio/plan.js';
import type { TimedCaption } from '../captions/lines.js';
import { DEFAULT_CAPTION_STYLE, type CaptionStyleId } from '../captions/styles.js';
import { stageAudio, stageCaptionFont } from '../compose/stage-assets.js';
import { DEFAULT_MOOD, type Storyboard, type TalkProps } from '../storyboard/schema.js';
import type { ProjectFile } from './project.js';

/** 背景乐选择：auto 按情绪自动选曲，none 不要配乐，其余视为曲目 id */
export interface AudioOptions { bgm: 'auto' | 'none' | string }

const FETCH_HINT = '运行 pnpm fetch-assets 可启用配乐与字体';

export interface AudioContext { workDir: string; cfg: AppConfig; input: string; audio?: AudioOptions; captionStyle?: CaptionStyleId }
export interface AudioPlan {
  /** 并入 Remotion 主合成的音频与字幕样式字段 */
  props: Pick<TalkProps, 'bgm' | 'sfx' | 'captionStyle' | 'captionFontFile'>;
  info: NonNullable<ProjectFile['audio']>;
  /** 一句话说明本次配乐与音效 */
  summary: string;
  /** 素材缺失导致的降级提示 */
  notes: string[];
}

/** 提前校验：曲目 id 必须存在，避免跑完剪辑才发现 */
export function validateAudio(audio: AudioOptions | undefined): void {
  const bgm = audio?.bgm ?? 'auto';
  if (bgm !== 'auto' && bgm !== 'none' && !loadTracks().some((t) => t.id === bgm)) {
    throw new Error(`未知曲目「${bgm}」，可用：auto、none 或 ${loadTracks().map((t) => t.id).join('、')}`);
  }
}

/** 选曲；配乐素材未下载时不报错，降级为无配乐并给出提示 */
function chooseTrack(ctx: AudioContext, storyboard: Storyboard): { track: Track | null; note?: string } {
  const want = ctx.audio?.bgm ?? 'auto';
  if (want === 'none') return { track: null };
  if (!musicReady(ctx.cfg, want)) return { track: null, note: `配乐素材未下载，本次不加背景乐；${FETCH_HINT}` };
  const tracks = downloadedTracks(ctx.cfg);
  const track = want === 'auto' ? pickTrack(tracks, storyboard.bgm ?? DEFAULT_MOOD, basename(ctx.input)) : tracks.find((t) => t.id === want);
  if (!track) throw new Error(`未知曲目「${want}」`);
  return { track };
}

/** 把背景乐、音效和所选字幕样式的字体落到工作目录，并算出渲染要用的字段 */
export async function prepareAudio(ctx: AudioContext, storyboard: Storyboard, captions: TimedCaption[], durationSec: number): Promise<AudioPlan> {
  const mood = storyboard.bgm ?? DEFAULT_MOOD;
  const style = ctx.captionStyle ?? DEFAULT_CAPTION_STYLE;
  const { track, note: musicNote } = chooseTrack(ctx, storyboard);
  const cues = sfxCues(storyboard.shots);
  const staged = await stageAudio(ctx.workDir, ctx.cfg, track, cues);
  const font = await stageCaptionFont(ctx.workDir, ctx.cfg, style);
  const bgm = track && staged.bgm ? { file: staged.bgm, keys: bgmEnvelope(captions, durationSec), durationSec: track.durationSec } : undefined;
  const label = track ? `配乐《${track.title}》（${mood}）` : '无背景乐';
  return {
    props: { ...(bgm ? { bgm } : {}), sfx: cues, captionStyle: style, captionFontFile: font.file },
    info: { track: track?.id ?? null, mood, sfxCount: cues.length },
    summary: `${label} · 音效 ${cues.length} 个 · 字幕样式 ${style}`,
    notes: [...(musicNote ? [musicNote] : []), ...(font.fallback ? [`字幕字体未下载，改用系统字体；${FETCH_HINT}`] : [])],
  };
}
