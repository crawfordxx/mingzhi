import type { AppConfig } from '../config.js';
import { rethrowIfBalance } from '../llm/errors.js';
import type { LlmClient } from '../llm/kexiang.js';
import { runBuffer } from '../media/exec.js';
import { probe } from '../media/probe.js';
import { cutoutFrame, type CutoutOptions } from '../matting/rvm.js';

export const FRAME_PICK_MODEL = 'google/gemini-3.5-flash';
const DEFAULT_CANDIDATES = 6;
/** 拼图每行几帧、每帧缩到多高（够模型看清表情即可） */
const GRID_COLS = 3;
const TILE_HEIGHT = 480;

const SYSTEM = '你是短视频封面的选帧助手，只输出 JSON。';

/** 把时长均分成 n 段，取各段中点作候选帧，避开开头结尾 */
export function candidateTimes(durationSec: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => ((i + 0.5) * durationSec) / n);
}

/** 按时间抽帧并拼成网格（从左到右、从上到下），返回 JPEG data URI */
async function frameGrid(video: string, times: number[], cfg: AppConfig): Promise<string> {
  const inputs = times.flatMap((t) => ['-ss', t.toFixed(3), '-i', video]);
  const tiles = times.map((_, i) => `[${i}:v]trim=end_frame=1,setpts=PTS-STARTPTS,scale=-2:${TILE_HEIGHT},setsar=1[v${i}]`);
  const rows = Math.ceil(times.length / GRID_COLS);
  const graph = `${tiles.join(';')};${times.map((_, i) => `[v${i}]`).join('')}concat=n=${times.length}:v=1:a=0,tile=${GRID_COLS}x${rows}[grid]`;
  const jpeg = await runBuffer(cfg.ffmpeg, ['-v', 'error', '-nostdin', ...inputs, '-filter_complex', graph, '-map', '[grid]', '-frames:v', '1', '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', '-']);
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

/** 均匀取若干帧拼图交给读图模型，选「眼睛睁开、表情自然、口型不夸张」的一帧，返回秒数；模型失败或答非所问时取 1/3 处 */
export async function pickPersonFrame(video: string, cfg: AppConfig, client: LlmClient, candidates = DEFAULT_CANDIDATES): Promise<number> {
  const { durationSec } = await probe(video, cfg);
  const times = candidateTimes(durationSec, candidates);
  const grid = await frameGrid(video, times, cfg);
  const user = `这张图是同一段口播视频按时间顺序均匀抽取的 ${times.length} 帧，按从左到右、从上到下排列，编号 1–${times.length}。`
    + '请选出最适合做封面人物的一帧：眼睛睁开、表情自然、口型不夸张、没有动作模糊。只输出 JSON：{"index": 编号}';
  try {
    const res = await client.chatJson({ model: FRAME_PICK_MODEL, system: SYSTEM, user, images: [grid], reasoningEffort: 'low' });
    const index = Number((res as { index?: unknown } | null)?.index);
    if (Number.isInteger(index) && index >= 1 && index <= times.length) return times[index - 1];
  } catch (err) {
    rethrowIfBalance(err);
    // 选帧只是锦上添花：模型不可用时用兜底帧，不中断出封面
  }
  return durationSec / 3;
}

/** 抽帧 → RVM 单帧抠像 → 按人物外接框裁切的 RGBA PNG；返回是否识别到人物（没有时输出整帧，透明度按模型结果） */
export async function cutoutPerson(video: string, sec: number, out: string, cfg: AppConfig, opts: CutoutOptions = {}): Promise<boolean> {
  const { found } = await cutoutFrame(video, sec, out, cfg, opts);
  return found;
}

/** 没抠到人时最多再试几个候选帧 */
const EXTRA_CUTOUT_TRIES = 2;
type Cutout = (video: string, sec: number, out: string, cfg: AppConfig, opts: CutoutOptions) => Promise<boolean>;

/** 先抠 sec 处；没识别到人物时再试离它最近的 2 个候选帧（与 pickPersonFrame 同一组时间点）；返回最终是否抠到人 */
export async function cutoutPersonWithRetry(video: string, sec: number, out: string, cfg: AppConfig, opts: CutoutOptions = {}, cutout: Cutout = cutoutPerson): Promise<boolean> {
  if (await cutout(video, sec, out, cfg, opts)) return true;
  const { durationSec } = await probe(video, cfg);
  const others = candidateTimes(durationSec, DEFAULT_CANDIDATES)
    .filter((t) => Math.abs(t - sec) > 1e-3)
    .sort((a, b) => Math.abs(a - sec) - Math.abs(b - sec))
    .slice(0, EXTRA_CUTOUT_TRIES);
  for (const t of others) {
    if (await cutout(video, t, out, cfg, opts)) return true;
  }
  return false;
}
