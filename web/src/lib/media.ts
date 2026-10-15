/** 浏览器本地读取视频元数据（不上传、不解码整段），读不出时返回 undefined */
export function probeDuration(file: File): Promise<number | undefined> {
  return probeVideo(file).then((m) => m?.duration);
}

export interface VideoMeta { duration: number; width: number; height: number }

export function probeVideo(file: File): Promise<VideoMeta | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = (meta?: VideoMeta) => { URL.revokeObjectURL(url); resolve(meta); };
    const timer = window.setTimeout(() => done(), 4000);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => {
      window.clearTimeout(timer);
      done(Number.isFinite(video.duration) ? { duration: video.duration, width: video.videoWidth, height: video.videoHeight } : undefined);
    };
    video.onerror = () => { window.clearTimeout(timer); done(); };
    video.src = url;
  });
}

/** 3:42 形式 */
export const fmtDuration = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const fmtSize = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const yuan = (v: number): string => `¥${v.toFixed(2)}`;

/** 口播只收视频与音频；按扩展名兜底（有些系统给 .mov 的 type 为空） */
export const isMediaFile = (f: File): boolean => /^(video|audio)\//.test(f.type) || /\.(mov|mp4|m4v|mkv|webm|mp3|m4a|wav|aac)$/i.test(f.name);
export const isImageFile = (f: File): boolean => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name);
