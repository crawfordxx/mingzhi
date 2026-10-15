/**
 * 播放时钟：一个或两个 <video> 共用（对比时同步播放）。不放在 React 状态里，组件按需订阅（useSyncExternalStore），
 * 根组件不会因为播放头每帧变化而重渲；播放头的通知节流到约 30 帧/秒。
 *
 * - 时长取最长的那个视频，主时钟也是它；其余视频每帧对齐（偏差 > 0.12 秒才跳）
 * - 较短的视频播到头就停在末帧，不再每帧 seek；拖回它的时长以内会接着放
 * - 最长的播完才算结束，所有视频一起暂停
 * - 视频挂上/卸下（切版本、开关对比）时先整体暂停，避免「按钮显示暂停、画面其实停了」
 */
export interface ClockState { t: number; duration: number; playing: boolean }

const DRIFT_SEC = 0.12;
const END_EPS = 0.05;
const POSTER_SEC = 1;
const EMIT_MS = 32;

interface Bound { el: HTMLVideoElement; off: () => void }

export class Clock {
  private videos = new Map<string, Bound>();
  private binders = new Map<string, (el: HTMLVideoElement | null) => void>();
  private subs = new Set<() => void>();
  private state: ClockState = { t: 0, duration: 0, playing: false };
  private raf = 0;
  private lastEmit = 0;

  getState = (): ClockState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  };

  private set(patch: Partial<ClockState>): void {
    const next = { ...this.state, ...patch };
    if (next.t === this.state.t && next.duration === this.state.duration && next.playing === this.state.playing) return;
    this.state = next;
    this.subs.forEach((fn) => fn());
  }

  private list(): HTMLVideoElement[] { return [...this.videos.values()].map((b) => b.el); }

  /** 主时钟：时长最长的视频（还没读到时长时取第一个） */
  private master(): HTMLVideoElement | undefined {
    return this.list().reduce<HTMLVideoElement | undefined>((best, v) => (!best || (v.duration || 0) > (best.duration || 0) ? v : best), undefined);
  }

  private maxDuration(): number { return Math.max(0, ...this.list().map((v) => (Number.isFinite(v.duration) ? v.duration : 0))); }

  /** 把一个视频摆到时间 t：超出它的时长就停在末帧 */
  private place(v: HTMLVideoElement, t: number, play: boolean): void {
    const end = (v.duration || Infinity) - END_EPS;
    if (t >= end) {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - end) > DRIFT_SEC && Number.isFinite(end)) v.currentTime = end;
      return;
    }
    if (Math.abs(v.currentTime - t) > DRIFT_SEC) v.currentTime = t;
    if (play && v.paused) void v.play().catch(() => this.pause());
  }

  private tick = (now: number): void => {
    const m = this.master();
    if (!m || !this.state.playing) return;
    const t = m.currentTime;
    this.videos.forEach(({ el }) => { if (el !== m) this.place(el, t, true); });
    if (m.ended || t >= this.state.duration - END_EPS / 2) { this.pause(); this.set({ t: this.state.duration }); return; }
    if (now - this.lastEmit >= EMIT_MS) { this.lastEmit = now; this.set({ t }); }
    this.raf = requestAnimationFrame(this.tick);
  };

  play = (): void => {
    const m = this.master();
    if (!m) return;
    const from = this.state.t >= this.state.duration - END_EPS ? 0 : this.state.t;
    this.list().forEach((v) => this.place(v, from, true));
    this.set({ playing: true, t: from });
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  };

  pause = (): void => {
    cancelAnimationFrame(this.raf);
    this.list().forEach((v) => v.pause());
    const m = this.master();
    this.set({ playing: false, ...(m ? { t: Math.min(m.currentTime, this.state.duration || m.currentTime) } : {}) });
  };

  toggle = (): void => (this.state.playing ? this.pause() : this.play());

  seek = (sec: number): void => {
    const max = this.state.duration > 0 ? this.state.duration - 0.04 : Math.max(0, sec);
    const to = Math.max(0, Math.min(max, sec));
    this.list().forEach((v) => this.place(v, to, this.state.playing));
    this.set({ t: to });
  };

  private onMeta(v: HTMLVideoElement): void {
    const duration = this.maxDuration();
    // 第 0 帧多半是卡片入场前的空白：首次打开停在第 1 秒，封面感更好
    const t = this.state.t === 0 && duration > POSTER_SEC * 3 ? POSTER_SEC : this.state.t;
    this.set({ duration, t });
    this.place(v, t, false);
  }

  /** <video ref={clock.bind('v2')}>：挂上时先整体暂停并对齐时间，卸下时移除监听 */
  bind = (key: string): ((el: HTMLVideoElement | null) => void) => {
    const cached = this.binders.get(key);
    if (cached) return cached;
    const fn = (el: HTMLVideoElement | null) => {
      const old = this.videos.get(key);
      if (old) { old.off(); old.el.pause(); this.videos.delete(key); }
      if (!el) { this.set({ duration: this.maxDuration() }); return; }
      if (this.state.playing) this.pause();
      const meta = () => this.onMeta(el);
      el.addEventListener('loadedmetadata', meta);
      this.videos.set(key, { el, off: () => el.removeEventListener('loadedmetadata', meta) });
      if (el.readyState >= 1) meta();
    };
    this.binders.set(key, fn);
    return fn;
  };
}
