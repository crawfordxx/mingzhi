/** 公告条右端：新版本胶囊的显示条件、退出确认里的任务提示 */
import type { Space, Status, UpdateInfo } from '../api';

/** 只打开本仓库的 Release 页面（服务端已校验，这里再挡一次） */
const RELEASE_PAGE = 'https://github.com/crawfordxx/mingzhi/releases/';

/**
 * 要显示的新版本；不显示时 null。
 * checkUpdates 是设置里的开关：false（刚关掉）立即不显示；undefined（还没读到）以服务端为准。
 */
export function updateToShow(status: Status | undefined, checkUpdates: boolean | undefined): UpdateInfo | null {
  const u = status?.update;
  if (!u || checkUpdates === false) return null;
  if (!u.version || u.version === status.version || !u.url.startsWith(RELEASE_PAGE)) return null;
  return u;
}

/** 退出确认里的提示：有任务排队或在跑时说明会被中断；没有任务时 null */
export function exitWarning(spaces: Space[]): string | null {
  const busy = spaces.filter((s) => s.job);
  if (busy.length === 0) return null;
  if (busy.length === 1) {
    const { state, version } = busy[0].job!;
    return `「${busy[0].title}」v${version} ${state === 'queued' ? '正在排队' : '正在出片'}，退出会中断它（已经花掉的费用不退）。`;
  }
  return `有 ${busy.length} 个任务正在出片或排队，退出会中断它们（已经花掉的费用不退）。`;
}
