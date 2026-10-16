import { sfxCues } from '../audio/sfx-plan.js';
import { readAssetMeta } from '../broll/credit-store.js';
import { rethrowIfCancelled } from '../cancel.js';
import type { Storyboard } from '../storyboard/schema.js';
import { measureFaceNoise, type FacePerson, type FaceNoiseResult } from './face-noise-measure.js';
import { analyzeGray, extractGray, type FrameSeries } from './film-frames.js';
import { filmReport, type FilmReport } from './film.js';
import { measureReadability, type ShotContrast } from './readability.js';

/**
 * video：成片；workDir：素材所在目录（渲染静帧的 publicDir）；metaDir：素材记录（同名 .json）所在目录，缺省同 workDir
 * （工作台的素材缓存与记录在 base/broll，版本目录里只有素材文件的引用）；outroStartSec：有品牌片尾时给出（音效规划要用）
 */
export interface MeasureOptions { ffmpeg: string; workDir: string; metaDir?: string; video: string; storyboard: Storyboard; outroStartSec?: number; signal?: AbortSignal;
  /** 人像视频与人物框：给出时加测「人脸区域高频噪声」（与无颗粒的人像对比）；缺省不测 */
  face?: FacePerson }

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 口播内容的结束时刻：镜头只覆盖口播内容（之后是留白与品牌片尾，按设计静止，不计入） */
export const contentEnd = (storyboard: Storyboard): number => storyboard.shots[storyboard.shots.length - 1]?.end ?? 0;

async function frames(o: MeasureOptions, endSec: number): Promise<{ frames?: FrameSeries; frameError?: string }> {
  try {
    return { frames: analyzeGray(await extractGray(o.ffmpeg, o.video, endSec, o.signal)) };
  } catch (err) {
    rethrowIfCancelled(err);
    return { frameError: message(err) };
  }
}

async function contrasts(o: MeasureOptions): Promise<{ contrasts?: ShotContrast[]; contrastError?: string }> {
  try {
    return { contrasts: await measureReadability({ workDir: o.workDir, storyboard: o.storyboard, ffmpeg: o.ffmpeg, signal: o.signal }) };
  } catch (err) {
    rethrowIfCancelled(err);
    return { contrastError: message(err) };
  }
}

async function faceNoise(o: MeasureOptions): Promise<{ faceNoise?: FaceNoiseResult | null; faceNoiseError?: string }> {
  if (!o.face) return {};
  try {
    return { faceNoise: await measureFaceNoise({ ffmpeg: o.ffmpeg, video: o.video, person: o.face, shots: o.storyboard.shots, signal: o.signal }) };
  } catch (err) {
    rethrowIfCancelled(err);
    return { faceNoiseError: message(err) };
  }
}

/** 整片度量：成片抽帧（静止、空白率、首帧）+ 分镜（多样性、覆盖、复用、音效）+ 铺图卡片可读性（渲染静帧）+ 人脸区域高频噪声（成片与无颗粒人像对比）；某类度量失败只跳过那一类 */
export async function measureFilm(o: MeasureOptions): Promise<FilmReport> {
  const durationSec = contentEnd(o.storyboard);
  const sfx = sfxCues(o.storyboard.shots, o.outroStartSec === undefined ? {} : { outroStartSec: o.outroStartSec });
  const candidateOf = (file: string): string | undefined => readAssetMeta(o.metaDir ?? o.workDir, file)?.candidateId;
  return filmReport({ storyboard: o.storyboard, durationSec, sfx, candidateOf, ...(await frames(o, durationSec)), ...(await contrasts(o)), ...(await faceNoise(o)) });
}
