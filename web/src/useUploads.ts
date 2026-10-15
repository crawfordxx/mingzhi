/**
 * 口播与背景上传：按项目分桶保存（切换项目不丢进度，切回来还能看到并取消），
 * 每个上传有自己的 AbortController，可随时取消；已上传的段可按下标删除。
 */
import { useCallback, useRef, useState } from 'react';
import { api, ApiError, type Space, type UploadedInput } from './api';
import { isImageFile, isVideoFile } from './lib/media';

export interface Upload {
  key: string;
  name: string;
  size: number;
  progress: number;
  state: 'uploading' | 'done' | 'error';
  error?: string;
  meta?: UploadedInput;
}
type Buckets = Readonly<Record<string, readonly Upload[]>>;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isCancel = (err: unknown) => err instanceof ApiError && err.message === '已取消';

/** 按下标删除已上传的一段口播（出片前） */
function useRemoveInput(
  space: Space | undefined, putSpace: (s: Space) => void, refresh: (s: Space) => void, notify: (m: string) => void, forget: (name: string) => void,
) {
  const forgetRef = useRef(forget);
  forgetRef.current = forget;
  const removeInput = useCallback(async (index: number) => {
    if (!space) return;
    const name = space.inputs[index];
    try {
      const next = await api.deleteInput(space.id, index);
      putSpace(next);
      forgetRef.current(name);
      refresh(next);
    } catch (err) {
      notify(`没删掉：${errText(err)}`);
    }
  }, [space, putSpace, refresh, notify]);
  return removeInput;
}

/** 背景图上传（按项目记进度） */
function useBackgroundUpload(space: Space | undefined, putSpace: (s: Space) => void, refresh: (s: Space) => void, notify: (m: string) => void) {
  const [bgUploads, setBgUploads] = useState<Readonly<Record<string, { name: string; progress: number }>>>({});
  const uploadBackground = useCallback(async (file: File) => {
    if (!space) return;
    if (!isImageFile(file)) { notify('背景只收图片（jpg / png / webp）'); return; }
    const id = space.id;
    const setBg = (v?: { name: string; progress: number }) => setBgUploads(({ [id]: _, ...rest }) => (v ? { ...rest, [id]: v } : rest));
    setBg({ name: file.name, progress: 0 });
    try {
      const next = await api.uploadBackground(id, file, { onProgress: (p) => setBg({ name: file.name, progress: p }) });
      putSpace(next);
      refresh(next);
    } catch (err) {
      notify(`背景上传失败：${errText(err)}`);
    } finally {
      setBg(undefined);
    }
  }, [space, putSpace, refresh, notify]);

  return { bgUpload: space ? bgUploads[space.id] : undefined, uploadBackground };
}

export function useUploads(space: Space | undefined, putSpace: (s: Space) => void, refresh: (s: Space) => void, notify: (m: string) => void) {
  const [buckets, setBuckets] = useState<Buckets>({});
  const controllers = useRef(new Map<string, AbortController>());

  const edit = (spaceId: string, fn: (list: readonly Upload[]) => readonly Upload[]) =>
    setBuckets((b) => ({ ...b, [spaceId]: fn(b[spaceId] ?? []) }));
  const patch = (spaceId: string, key: string, p: Partial<Upload>) => edit(spaceId, (l) => l.map((u) => (u.key === key ? { ...u, ...p } : u)));

  const uploadOne = useCallback(async (spaceId: string, file: File) => {
    const key = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const ctl = new AbortController();
    controllers.current.set(key, ctl);
    edit(spaceId, (l) => [...l, { key, name: file.name, size: file.size, progress: 0, state: 'uploading' }]);
    try {
      const res = await api.uploadInput(spaceId, file, { signal: ctl.signal, onProgress: (p) => patch(spaceId, key, { progress: p }) });
      const { uploaded, ...next } = res;
      putSpace(next);
      patch(spaceId, key, { progress: 1, state: 'done', name: uploaded?.name ?? file.name, meta: uploaded });
      refresh(next);
    } catch (err) {
      if (isCancel(err)) edit(spaceId, (l) => l.filter((u) => u.key !== key));
      else patch(spaceId, key, { state: 'error', error: errText(err) });
    } finally {
      controllers.current.delete(key);
    }
  }, [putSpace, refresh]);

  const addInputs = useCallback(async (files: File[]) => {
    if (!space) return;
    const videos = files.filter(isVideoFile);
    if (videos.length < files.length) notify('只收视频文件（mp4 / mov / mkv / webm），其他文件已跳过');
    for (const file of videos) await uploadOne(space.id, file);
  }, [space, uploadOne, notify]);

  const cancelUpload = useCallback((key: string) => controllers.current.get(key)?.abort(), []);
  const dropUpload = useCallback((key: string) => { if (space) edit(space.id, (l) => l.filter((u) => u.key !== key)); }, [space]);


  const uploads = space ? buckets[space.id] ?? [] : [];
  const forget = (name: string) => {
    if (space) edit(space.id, (l) => l.filter((u) => !(u.state === 'done' && u.name === name)));
  };
  const removeInput = useRemoveInput(space, putSpace, refresh, notify, forget);
  return { uploads, addInputs, cancelUpload, dropUpload, removeInput, ...useBackgroundUpload(space, putSpace, refresh, notify) };
}
