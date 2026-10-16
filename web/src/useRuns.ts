/**
 * 出片与版本：事件直播（每个版本一份事件）、版本状态缓存、当前预览哪个版本、对比开关、导出与回退。
 * 对话（发消息、选选项、@ 引用）在 useConversation.ts。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Space, type VersionMeta, type VersionState, type WorkEvent } from './api';
import { isTerminal, loadHistory } from './live';
import { copyText } from './lib/clipboard';
import { exportNotice } from './lib/exportNotice';
import { errText, type Notify } from './useWorkbench';

export const doneVersions = (space?: Space): VersionMeta[] => (space?.versions ?? []).filter((v) => v.status === 'done');
/** 正在排队或运行的版本号 */
export const activeVersion = (space?: Space): number | undefined =>
  space?.job?.version ?? space?.versions.find((v) => v.status === 'running')?.n;

const vkey = (id: string, n: number) => `${id}:${n}`;

/** 导出目录显示时把用户主目录缩成 ~（macOS /Users/x、Linux /home/x、Windows C:\\Users\\x） */
export const shortDir = (dir: string): string => dir.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, '~');

/** 活动版本的实时订阅；断线时 offline 为 true，重新连上时补一次项目状态 */
function useActiveStream(id: string | undefined, active: number | undefined, refresh: (id: string) => Promise<void>,
  put: (k: string, fn: (list: WorkEvent[]) => WorkEvent[]) => void) {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (!id || !active) { setOffline(false); return undefined; }
    const k = vkey(id, active);
    put(k, () => []);
    let wasOff = false;
    const close = api.events(id, active, (e) => {
      put(k, (list) => [...list, e]);
      if (isTerminal(e)) { void refresh(id); window.setTimeout(() => void refresh(id), 900); }
    }, (online) => {
      setOffline(!online);
      if (online && wasOff) void refresh(id);
      wasOff = !online;
    });
    return () => { close(); setOffline(false); };
  }, [id, active, refresh, put]);
  return offline;
}

/** 每个版本的事件：活动版本走实时订阅，已结束的版本一条一条补历史 */
function useVersionEvents(space: Space | undefined, refresh: (id: string) => Promise<void>) {
  const [events, setEvents] = useState<Record<string, WorkEvent[]>>({});
  const requested = useRef(new Set<string>());
  const current = useRef<string>();
  const id = space?.id;
  current.current = id;
  const active = activeVersion(space);
  const put = useCallback((k: string, fn: (list: WorkEvent[]) => WorkEvent[]) => setEvents((m) => ({ ...m, [k]: fn(m[k] ?? []) })), []);
  useEffect(() => { if (id && active) requested.current.add(vkey(id, active)); }, [id, active]);
  const offline = useActiveStream(id, active, refresh, put);

  // 已结束的版本：补一次历史（剪辑直播的完成态、重播、版本卡的耗时都要用）；切走了就跳过，下次回来再补
  useEffect(() => {
    if (!space) return;
    space.versions.filter((v) => v.status !== 'running' && v.n !== active).forEach((v) => {
      const k = vkey(space.id, v.n);
      if (requested.current.has(k)) return;
      requested.current.add(k);
      void loadHistory(space.id, v.n, () => current.current === space.id).then((list) => {
        if (list) put(k, () => list);
        else requested.current.delete(k);
      });
    });
  }, [space, active, put]);

  const of = useCallback((n: number): WorkEvent[] => (id ? events[vkey(id, n)] ?? [] : []), [events, id]);
  return { of, offline };
}

/** 版本状态（分镜、字幕）按需取并缓存 */
function useVersionStates(space: Space | undefined) {
  const [states, setStates] = useState<Record<string, VersionState>>({});
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!space) return;
    doneVersions(space).forEach((v) => {
      const k = vkey(space.id, v.n);
      if (asked.current.has(k)) return;
      asked.current.add(k);
      api.versionState(space.id, v.n).then((st) => setStates((m) => ({ ...m, [k]: st })), () => asked.current.delete(k));
    });
  }, [space]);
  return useCallback((n: number): VersionState | undefined => (space ? states[vkey(space.id, n)] : undefined), [states, space]);
}

/** 当前预览的版本：默认最新完成版；新版本完成时自动切过去 */
function useViewVersion(space: Space | undefined) {
  const done = doneVersions(space);
  const latest = done.at(-1)?.n;
  const [pick, setPick] = useState<Record<string, number>>({});
  const seen = useRef<Record<string, number | undefined>>({});
  const id = space?.id;
  useEffect(() => {
    if (!id) return;
    const before = seen.current[id];
    seen.current[id] = latest;
    if (before !== undefined && latest !== undefined && latest > before) setPick((p) => ({ ...p, [id]: latest }));
  }, [id, latest]);
  const chosen = id ? pick[id] : undefined;
  const view = chosen !== undefined && done.some((v) => v.n === chosen) ? chosen : latest;
  const setView = useCallback((n: number) => { if (id) setPick((p) => ({ ...p, [id]: n })); }, [id]);
  return { view, setView };
}

interface Deps { space?: Space; putSpace: (s: Space) => void; notify: Notify }

export function useRuns({ space, putSpace, notify }: Deps) {
  const refresh = useCallback(async (id: string) => {
    try { putSpace(await api.getSpace(id)); } catch (err) { notify(`刷新项目失败：${errText(err)}`); }
  }, [putSpace, notify]);
  const { of: eventsOf, offline } = useVersionEvents(space, refresh);
  const stateOf = useVersionStates(space);
  const { view, setView } = useViewVersion(space);
  const [compare, setCompare] = useState(false);
  const [exporting, setExporting] = useState<number>();
  const done = doneVersions(space);
  const viewMeta = done.find((v) => v.n === view);
  const parentOf = (n: number) => done.find((v) => v.n === (done.find((d) => d.n === n)?.parent ?? n - 1)) ?? done.filter((v) => v.n < n).at(-1);
  const compareWith = view !== undefined ? parentOf(view)?.n : undefined;
  const canCompare = compareWith !== undefined;

  const exportVersion = useCallback(async (n: number) => {
    if (!space) return;
    setExporting(n);
    try {
      const out = await api.exportVersion(space.id, n);
      const { text, action } = exportNotice(out, shortDir(out.dir));
      const copy = () => void copyText(out.attribution ?? '').then((ok) => notify(ok ? '署名文本已复制，发布时贴在正文末尾' : '复制失败，请到「素材来源」里手动复制'));
      notify(text, action === 'copy' ? { label: '复制署名文本', run: copy } : action === 'ack' ? { label: '知道了', run: () => undefined } : undefined);
    } catch (err) {
      notify(`导出失败：${errText(err)}`);
    } finally {
      setExporting(undefined);
    }
  }, [space, notify]);

  const revert = useCallback(async (n: number) => {
    if (!space) return;
    try { await api.revert(space.id, n); await refresh(space.id); } catch (err) { notify(`回退失败：${errText(err)}`); }
  }, [space, refresh, notify]);

  const cancel = useCallback(async () => {
    if (!space) return;
    try { await api.cancel(space.id); await refresh(space.id); } catch (err) { notify(`取消失败：${errText(err)}`); }
  }, [space, refresh, notify]);

  return useMemo(() => ({
    eventsOf, stateOf, view, viewMeta, setView, compare: compare && canCompare, setCompare, canCompare, compareWith,
    active: activeVersion(space), offline, exporting, exportVersion, revert, cancel, refresh,
  }), [offline, eventsOf, stateOf, view, viewMeta, setView, compare, canCompare, compareWith, space, exporting, exportVersion, revert, cancel, refresh]);
}

export type Runs = ReturnType<typeof useRuns>;
