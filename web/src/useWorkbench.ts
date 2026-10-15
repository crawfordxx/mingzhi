/** 工作台状态：项目列表、当前项目、选项、预估与上传队列；所有更新走不可变替换 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Estimate, type Options, type Space, type SpaceSettings, type Status } from './api';
import { isImageFile, isMediaFile, probeVideo, type VideoMeta } from './lib/media';

export interface Upload { key: string; name: string; size: number; progress: number; state: 'uploading' | 'done' | 'error'; error?: string; meta?: VideoMeta }

const errText = (err: unknown): string => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

function useToast() {
  const [toast, setToast] = useState<string>();
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(undefined), 2600);
    return () => window.clearTimeout(id);
  }, [toast]);
  return { toast, notify: useCallback((msg: string) => setToast(msg), []) };
}

/** 首屏：状态、选项、项目一起取；没有项目时建一个空的 */
function useBoot() {
  const [status, setStatus] = useState<Status>();
  const [options, setOptions] = useState<Options>();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [currentId, setCurrentId] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [st, opts, list] = await Promise.all([api.status(), api.options(), api.listSpaces()]);
        const all = list.length ? list : [await api.createSpace()];
        if (!alive) return;
        setStatus(st); setOptions(opts); setSpaces(all); setCurrentId(all[0].id);
      } catch (err) {
        if (alive) setLoadError(errText(err));
      }
    })();
    return () => { alive = false; };
  }, []);
  return { status, setStatus, options, spaces, setSpaces, currentId, setCurrentId, loadError };
}

/** 预估：只采纳最后一次请求的结果，避免快速改设置时旧结果覆盖新结果 */
function useEstimate(notify: (m: string) => void) {
  const [estimate, setEstimate] = useState<Estimate>();
  const [estimating, setEstimating] = useState(false);
  const seq = useRef(0);
  const refresh = useCallback(async (id: string) => {
    const mine = ++seq.current;
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
  return { estimate, setEstimate, estimating, refresh };
}

/** 口播逐段上传：本地先读时长/分辨率，上传进度来自 XHR */
function useUploads(space: Space | undefined, putSpace: (s: Space) => void, after: (id: string) => void, notify: (m: string) => void) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const patch = (key: string, p: Partial<Upload>) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...p } : u)));
  const addInputs = useCallback(async (files: File[]) => {
    if (!space) return;
    const media = files.filter(isMediaFile);
    if (media.length < files.length) notify('只收视频或音频文件，其他文件已跳过');
    for (const file of media) {
      const key = `${file.name}-${file.size}-${Date.now()}`;
      setUploads((list) => [...list, { key, name: file.name, size: file.size, progress: 0, state: 'uploading' }]);
      void probeVideo(file).then((meta) => meta && patch(key, { meta }));
      try {
        putSpace(await api.uploadInput(space.id, file, (p) => patch(key, { progress: p })));
        patch(key, { progress: 1, state: 'done' });
      } catch (err) {
        patch(key, { state: 'error', error: errText(err) });
      }
    }
    after(space.id);
  }, [space, putSpace, after, notify]);
  const dropUpload = useCallback((key: string) => setUploads((list) => list.filter((u) => u.key !== key)), []);
  return { uploads, setUploads, addInputs, dropUpload };
}

/** 当前项目上的操作：改设置（乐观更新，失败回滚）、上传背景、开始出片 */
function useSpaceActions(space: Space | undefined, putSpace: (s: Space) => void, refresh: (id: string) => void, notify: (m: string) => void) {
  const [bgUpload, setBgUpload] = useState<{ name: string; progress: number }>();
  const [starting, setStarting] = useState(false);

  const updateSettings = useCallback(async (patch: Partial<SpaceSettings>) => {
    if (!space) return;
    putSpace({ ...space, settings: { ...space.settings, ...patch } });
    try {
      putSpace(await api.patchSpace(space.id, { settings: patch }));
      refresh(space.id);
    } catch (err) {
      putSpace(space);
      notify(`没保存上：${errText(err)}`);
    }
  }, [space, putSpace, refresh, notify]);

  const uploadBackground = useCallback(async (file: File) => {
    if (!space) return;
    if (!isImageFile(file)) { notify('背景只收图片（jpg / png / webp）'); return; }
    setBgUpload({ name: file.name, progress: 0 });
    try {
      putSpace(await api.uploadBackground(space.id, file, (p) => setBgUpload({ name: file.name, progress: p })));
      refresh(space.id);
    } catch (err) {
      notify(`背景上传失败：${errText(err)}`);
    } finally {
      setBgUpload(undefined);
    }
  }, [space, putSpace, refresh, notify]);

  const start = useCallback(async () => {
    if (!space) return;
    setStarting(true);
    try {
      await api.start(space.id);
      putSpace(await api.getSpace(space.id));
    } catch (err) {
      notify(errText(err));
    } finally {
      setStarting(false);
    }
  }, [space, putSpace, notify]);

  return { bgUpload, starting, updateSettings, uploadBackground, start };
}

export function useWorkbench() {
  const { toast, notify } = useToast();
  const { status, setStatus, options, spaces, setSpaces, currentId, setCurrentId, loadError } = useBoot();
  const { estimate, setEstimate, estimating, refresh } = useEstimate(notify);
  const space = useMemo(() => spaces.find((s) => s.id === currentId), [spaces, currentId]);
  const putSpace = useCallback((next: Space) => setSpaces((list) => list.map((s) => (s.id === next.id ? next : s))), [setSpaces]);
  const { uploads, setUploads, addInputs, dropUpload } = useUploads(space, putSpace, refresh, notify);
  const actions = useSpaceActions(space, putSpace, refresh, notify);

  useEffect(() => { setUploads([]); setEstimate(undefined); if (currentId) void refresh(currentId); }, [currentId, refresh, setUploads, setEstimate]);

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

  return {
    status, options, spaces, space, loadError, toast, estimate, estimating, uploads, ...actions,
    selectSpace: setCurrentId, newSpace, addInputs, dropUpload, keyVerified, notify,
  };
}

export type Workbench = ReturnType<typeof useWorkbench>;
