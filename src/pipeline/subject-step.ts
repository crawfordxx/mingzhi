import type { AppConfig } from '../config.js';
import { rethrowIfCancelled } from '../cancel.js';
import type { SubjectBox } from '../matting/composite.js';
import { mediaOf, type MediaDeps } from './media-deps.js';
import type { Complete } from './stages.js';

/**
 * 不换背景时的人物取景：抽几帧本地跑 RVM 求人物框，写进 project.json 的 subject（与抠像路径一致）。
 * 没人或失败都不中断流程：subject 为 null，分屏按画面居中，进度消息写明原因
 */
export async function subjectStage(
  args: { cfg: AppConfig; signal?: AbortSignal; media?: Partial<MediaDeps> }, cut: string, complete: Complete,
): Promise<SubjectBox | null> {
  const started = Date.now();
  let subject: SubjectBox | null = null;
  let note = '画面里没有检测到人物，分屏按画面居中';
  try {
    subject = await mediaOf(args.media).subject(cut, args.cfg, { signal: args.signal });
    if (subject) note = '';
  } catch (err) {
    rethrowIfCancelled(err);
    note = `${err instanceof Error ? err.message : String(err)}，分屏按画面居中`;
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  complete('matte', subject ? `人物取景完成（不换背景，抽帧识别）· 用时 ${secs} 秒` : `人物取景未得到人物框：${note}`, { subject });
  return subject;
}
