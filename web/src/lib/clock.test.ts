import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Clock } from './clock';

/** 只实现时钟用到的那几个属性的假 video */
class FakeVideo {
  currentTime = 0;
  paused = true;
  ended = false;
  readyState = 1;
  seeks = 0;
  constructor(public duration: number) {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  addEventListener() {}
  removeEventListener() {}
}

let frame: ((now: number) => void) | undefined;
let now = 0;
const step = (master: FakeVideo, to: number) => { master.currentTime = to; now += 40; const f = frame; frame = undefined; f?.(now); };

beforeEach(() => {
  (globalThis as Record<string, unknown>).requestAnimationFrame = (f: (n: number) => void) => { frame = f; return 1; };
  (globalThis as Record<string, unknown>).cancelAnimationFrame = () => { frame = undefined; };
});
afterEach(() => { frame = undefined; });

function pair() {
  const clock = new Clock();
  const short = new FakeVideo(10);
  const long = new FakeVideo(12);
  clock.bind('a')(short as unknown as HTMLVideoElement);
  clock.bind('b')(long as unknown as HTMLVideoElement);
  return { clock, short, long };
}

describe('播放时钟（对比时两个视频共用）', () => {
  it('时长取较长的一方，seek 能拖到较长一方的尾部', () => {
    const { clock, long } = pair();
    expect(clock.getState().duration).toBe(12);
    clock.seek(11.5);
    expect(long.currentTime).toBe(11.5);
  });

  it('较短的一方播到头停在末帧、不再每帧 seek；较长的播完后全部暂停', () => {
    const { clock, short, long } = pair();
    clock.seek(0);
    clock.play();
    expect(short.paused || long.paused).toBe(false);
    step(long, 10.5);
    expect(short.paused).toBe(true);
    const parked = short.currentTime;
    step(long, 11);
    expect(short.currentTime).toBe(parked);
    long.ended = true;
    step(long, 12);
    expect(clock.getState().playing).toBe(false);
    expect(long.paused && short.paused).toBe(true);
  });

  it('播放中挂上新视频（切版本 / 开关对比）会先整体暂停，状态与画面一致', () => {
    const { clock, short, long } = pair();
    clock.play();
    clock.bind('c')(new FakeVideo(8) as unknown as HTMLVideoElement);
    expect(clock.getState().playing).toBe(false);
    expect(short.paused && long.paused).toBe(true);
  });
});
