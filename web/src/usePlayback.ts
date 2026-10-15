/**
 * 播放时钟：一个或两个 <video> 共用一个时钟（对比时同步播放）。
 * 第一个注册的视频是主时钟，其余每帧对齐它（偏差超过 0.12 秒才跳，避免抖动）；
 * 拖动任何一个进度条都调用 seek，所有视频一起跳。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const DRIFT_SEC = 0.12;
const POSTER_SEC = 1;

export interface Clock {
  t: number;
  duration: number;
  playing: boolean;
  /** 有视频可播（加载出元数据） */
  ready: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (sec: number) => void;
  /** <video ref={clock.bind('v2')}>：挂上/卸下视频 */
  bind: (key: string) => (el: HTMLVideoElement | null) => void;
}

function useVideos() {
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const master = useCallback(() => videos.current.values().next().value as HTMLVideoElement | undefined, []);
  return { videos, master };
}

export function usePlayback(): Clock {
  const { videos, master } = useVideos();
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const binders = useRef(new Map<string, (el: HTMLVideoElement | null) => void>());
  const tRef = useRef(0);

  // 播放中：每帧读主时钟，并把其余视频拉齐
  useEffect(() => {
    if (!playing) return undefined;
    let id = 0;
    const loop = () => {
      const m = master();
      if (m) {
        tRef.current = m.currentTime;
        setT(m.currentTime);
        videos.current.forEach((v) => { if (v !== m && Math.abs(v.currentTime - m.currentTime) > DRIFT_SEC) v.currentTime = m.currentTime; });
        if (m.ended) setPlaying(false);
      }
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [playing, master, videos]);

  const pause = useCallback(() => { videos.current.forEach((v) => v.pause()); setPlaying(false); }, [videos]);
  const play = useCallback(() => {
    const m = master();
    if (!m) return;
    if (m.ended || m.currentTime >= (m.duration || Infinity) - 0.05) videos.current.forEach((v) => { v.currentTime = 0; });
    videos.current.forEach((v) => { void v.play().catch(() => setPlaying(false)); });
    setPlaying(true);
  }, [master, videos]);
  const seek = useCallback((sec: number) => {
    const m = master();
    const max = m?.duration && Number.isFinite(m.duration) ? m.duration - 0.04 : sec;
    const to = Math.max(0, Math.min(max, sec));
    videos.current.forEach((v) => { v.currentTime = to; });
    tRef.current = to;
    setT(to);
  }, [master, videos]);

  const bind = useCallback((key: string) => {
    const cached = binders.current.get(key);
    if (cached) return cached;
    const fn = (el: HTMLVideoElement | null) => {
      if (!el) { videos.current.get(key)?.pause(); videos.current.delete(key); return; }
      videos.current.set(key, el);
      const sync = () => {
        if (el === master()) {
          setDuration(el.duration || 0);
          // 第 0 帧多半是卡片入场前的空白：首次打开停在第 1 秒，封面感更好
          if (tRef.current === 0 && el.duration > POSTER_SEC * 3) { tRef.current = POSTER_SEC; setT(POSTER_SEC); }
        }
        if (Math.abs(el.currentTime - tRef.current) > DRIFT_SEC) el.currentTime = Math.min(tRef.current, (el.duration || tRef.current) - 0.04);
      };
      el.addEventListener('loadedmetadata', sync);
      if (el.readyState >= 1) sync();
    };
    binders.current.set(key, fn);
    return fn;
  }, [master, videos]);

  return useMemo(() => ({ t, duration, playing, ready: duration > 0, play, pause, toggle: () => (playing ? pause() : play()), seek, bind }), [t, duration, playing, play, pause, seek, bind]);
}
