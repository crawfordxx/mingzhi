import { normalizeStoryboard, type NormalizeResult } from '../storyboard/normalize.js';
import { HOOK_WINDOW_SEC, MAX_SHOT_SEC, type Storyboard } from '../storyboard/schema.js';

/** 分镜里已经引用的素材文件名：归一化时视为可用，避免把现有卡片当成素材缺失 */
function filesOf(sb: Storyboard): string[] {
  return sb.shots.flatMap((s) => {
    const p = (s.card?.props ?? {}) as { image?: string; video?: string };
    return [p.image, p.video].filter((f): f is string => typeof f === 'string');
  });
}

/** 按现有分镜归一化规则（cta 位置、hook 窗口与编号、卡片镜头限长、短镜头合并等）整理分镜；空分镜原样返回 */
export function canonicalize(sb: Storyboard): NormalizeResult {
  const last = sb.shots[sb.shots.length - 1];
  if (!last) return { storyboard: sb, dropped: 0, demoted: 0, capped: 0 };
  return normalizeStoryboard(sb, last.end, filesOf(sb));
}

/** 修改后的分镜比修改前多触犯了哪条版式规则（复用 normalizeStoryboard 的统计），没有则返回 null */
export function layoutProblem(before: Storyboard, after: Storyboard): string | null {
  const b = canonicalize(before);
  const a = canonicalize(after);
  if (a.capped > b.capped) return `带卡片的镜头最长 ${MAX_SHOT_SEC} 秒，这个镜头太长放不下卡片`;
  if (a.demoted > b.demoted) return `版式规则不允许：cta 只能放在最后一个镜头，hook 只能放在前 ${HOOK_WINDOW_SEC} 秒内且最多 3 张，镜头也不能太短`;
  if (a.dropped > b.dropped) return '这张卡片在该镜头里无法显示';
  return null;
}
