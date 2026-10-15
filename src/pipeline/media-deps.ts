import { transcribeWav } from '../asr/local-asr.js';
import { normalizeLoudness } from '../audio/loudness.js';
import type { SegmentBackend } from '../compose/segments.js';
import { renderCut } from '../cut/render-cut.js';
import { compositeMatte } from '../matting/composite-matte.js';
import { matteVideo } from '../matting/rvm.js';
import { extractWav16k } from '../media/extract-audio.js';
import { probe } from '../media/probe.js';

/** 流程里耗时的本地媒体处理（探测、识别、剪切、抠像、合成、渲染、响度）；缺省为真实实现，仅供测试注入假实现 */
export interface MediaDeps {
  probe: typeof probe;
  extractWav: typeof extractWav16k;
  transcribe: typeof transcribeWav;
  renderCut: typeof renderCut;
  matte: typeof matteVideo;
  composite: typeof compositeMatte;
  /** 分段渲染的打包、渲染与拼接；缺省为真实 Remotion + ffmpeg */
  segments?: SegmentBackend;
  loudness: typeof normalizeLoudness;
}

const REAL_MEDIA: MediaDeps = {
  probe, extractWav: extractWav16k, transcribe: transcribeWav, renderCut, matte: matteVideo, composite: compositeMatte, loudness: normalizeLoudness,
};

/** 注入的实现覆盖真实实现 */
export const mediaOf = (media: Partial<MediaDeps> | undefined): MediaDeps => ({ ...REAL_MEDIA, ...media });
