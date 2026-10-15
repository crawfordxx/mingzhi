/** 工作台状态：项目列表、当前项目、选项、预估与上传队列；所有更新走不可变替换 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Estimate, type Options, type SettingsPatch, type Space, type Status } from './api';
import { useUploads } from './useUploads';

export type { Upload } from './useUploads';

export const errText = (err: unknown): string => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

function useToast() {
  const [toast, setToast] = useState<string>();
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(undefined), 2600);
    return () => window.clearTimeout(id);
  }, [toast]);
  return { toast, notify: useCallback((msg: string) => setToast(msg), []) };
}

type BootData = { status: Status; options: Options; spaces: Space[] };
/** 首屏数据只取一次（StrictMode 开发模式下 effect 会跑两遍，不能建出两个空项目） */
let bootOnce: Promise<BootData> | undefined;
const loadBoot = () => (bootOnce ??= (async () => {
  const [status, options, list] = await Promise.all([api.status(), api.options(), api.listSpaces()]);
  return { status, options, spaces: list.length ? list : [await api.createSpace()] };
})());

function useBoot() {
  const [status, setStatus] = useState<Status>();
  const [options, setOptions] = useState<Options>();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [currentId, setCurrentId] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    let alive = true;
    loadBoot().then((d) => {
      if (!alive) return;
      setStatus(d.status); setOptions(d.options); setSpaces(d.spaces); setCurrentId(d.spaces[0].id);
    }, (err: unknown) => { bootOnce = undefined; if (alive) setLoadError(errText(err)); });
    return () => { alive = false; };
  }, []);
  return { status, setStatus, options, spaces, setSpaces, currentId, setCurrentId, loadError };
}

/** 预估：只采纳当前项目最后一次请求的结果；没有口播时不请求（服务端会 400） */
function useEstimate(current: Space | undefined, notify: (m: string) => void) {
  const [estimate, setEstimate] = useState<Estimate>();
  const [estimating, setEstimating] = useState(false);
  const seq = useRef(0);
  const currentRef = useRef(current);
  currentRef.current = current;
  /** 传入服务端刚返回的项目；不是当前项目就忽略（切回来时会重新估） */
  const refresh = useCallback(async (target: Space) => {
    const id = target.id;
    if (currentRef.current?.id !== id) return;
    const mine = ++seq.current;
    if (!target.inputs.length) { setEstimate(undefined); setEstimating(false); return; }
    setEstimating(true);
    try {
      const est = await api.estimate(id);
      if (mine === seq.current) setEstimate(est);
    } catch (err) {
      if (mine === seq.current) setEstimate(undefined);
      notify(`预估失败：${errText(err)}`);
    } finally {
      if (mine === seq.current) setEstimating(false);
    }
  }, [notify]);
  return { estimate, estimating, refresh };
}

/**
 * 当前项目上的操作。设置保存按顺序串行（一句话背景失焦提交后紧接着点开始，也保证先存设置再开始）；
 * 保存失败时以服务端为准重新取一次项目，而不是回滚到闭包里的旧值。
 */
function useSpaceActions(space: Space | undefined, putSpace: (s: Space) => void, refresh: (s: Space) => void, notify: (m: string) => void) {
  const [starting, setStarting] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const updateSettings = useCallback((patch: SettingsPatch) => {
    if (!space) return Promise.resolve();
    const { background, ...rest } = { ...space.settings, ...patch };
    putSpace({ ...space, settings: background ? { ...rest, background } : rest });
    const id = space.id;
    const run = queue.current.then(async () => {
      let saved: Space | undefined;
      try {
        saved = await api.patchSpace(id, { settings: patch });
      } catch (err) {
        notify(`没保存上：${errText(err)}`);
        saved = await api.getSpace(id).catch(() => undefined);
      }
      if (saved) { putSpace(saved); refresh(saved); }
    });
    queue.current = run;
    return run;
  }, [space, putSpace, refresh, notify]);

  const start = useCallback(async () => {
    if (!space) return;
    setStarting(true);
    try {
      await queue.current;
      try { await api.start(space.id); } catch (err) { notify(errText(err)); return; }
      try { putSpace(await api.getSpace(space.id)); } catch (err) { notify(`已开始出片，但刷新项目状态失败：${errText(err)}`); }
    } finally {
      setStarting(false);
    }
  }, [space, putSpace, notify]);

  return { starting, updateSettings, start };
}

export function useWorkbench() {
  const { toast, notify } = useToast();
  const { status, setStatus, options, spaces, setSpaces, currentId, setCurrentId, loadError } = useBoot();
  const space = useMemo(() => spaces.find((s) => s.id === currentId), [spaces, currentId]);
  const { estimate, estimating, refresh } = useEstimate(space, notify);
  const putSpace = useCallback((next: Space) => setSpaces((list) => list.map((s) => (s.id === next.id ? next : s))), [setSpaces]);
  const up = useUploads(space, putSpace, refresh, notify);
  const actions = useSpaceActions(space, putSpace, refresh, notify);

  // 只在切换项目时重估；其余时机由上传/保存拿到服务端结果后触发
  const spaceRef = useRef(space);
  spaceRef.current = space;
  useEffect(() => { if (spaceRef.current) void refresh(spaceRef.current); }, [currentId, refresh]);

  const newSpace = useCallback(async () => {
    try {
      const created = await api.createSpace();
      setSpaces((list) => [created, ...list]);
      setCurrentId(created.id);
    } catch (err) {
      notify(`新建失败：${errText(err)}`);
    }
  }, [notify, setSpaces, setCurrentId]);

  const keyVerified = useCallback(() => setStatus((s) => (s ? { ...s, keyConfigured: true } : s)), [setStatus]);

  return { status, options, spaces, space, loadError, toast, estimate, estimating, ...up, ...actions, selectSpace: setCurrentId, newSpace, keyVerified, notify };
}

export type Workbench = ReturnType<typeof useWorkbench>;
