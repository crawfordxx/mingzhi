import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { parseProbe, probe } from '../src/media/probe.js';
import { extractWav16k } from '../src/media/extract-audio.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'talk.mp4');
const cfg = loadConfig({});

describe('parseProbe', () => {
  it('解析视频流、音频流、帧率与时长', () => {
    const info = parseProbe({
      format: { duration: '12.5' },
      streams: [
        { codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '30000/1001' },
        { codec_type: 'audio' },
      ],
    });
    expect(info).toEqual({ durationSec: 12.5, width: 1080, height: 1920, fps: 29.97, hasAudio: true });
  });

  it('format.duration 为 N/A 或缺失时回退视频流时长，仍无效则报错', () => {
    const video = { codec_type: 'video', width: 540, height: 960, r_frame_rate: '30/1', duration: '9.5' };
    expect(parseProbe({ format: { duration: 'N/A' }, streams: [video] }).durationSec).toBe(9.5);
    expect(parseProbe({ format: {}, streams: [video] }).durationSec).toBe(9.5);
    expect(() => parseProbe({ format: { duration: 'N/A' }, streams: [{ ...video, duration: 'N/A' }] })).toThrow('无法读取视频时长');
    expect(() => parseProbe({ streams: [{ ...video, duration: undefined }] })).toThrow('无法读取视频时长');
  });

  describe('旋转视频返回显示尺寸', () => {
    const base = { codec_type: 'video', width: 1920, height: 1080, r_frame_rate: '30/1' };
    const dims = (video: object): [number, number] => {
      const info = parseProbe({ format: { duration: '1' }, streams: [{ ...base, ...video }] });
      return [info.width, info.height];
    };
    it('side_data_list 的 displaymatrix 旋转 -90 / 90 / 270 时宽高互换', () => {
      expect(dims({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] })).toEqual([1080, 1920]);
      expect(dims({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }] })).toEqual([1080, 1920]);
      expect(dims({ side_data_list: [{ rotation: 270 }] })).toEqual([1080, 1920]);
    });
    it('tags.rotate 为 90 时宽高互换', () => {
      expect(dims({ tags: { rotate: '90' } })).toEqual([1080, 1920]);
      expect(dims({ tags: { rotate: '-270' } })).toEqual([1080, 1920]);
    });
    it('旋转 180 或 0 不互换', () => {
      expect(dims({ side_data_list: [{ rotation: 180 }] })).toEqual([1920, 1080]);
      expect(dims({ side_data_list: [{ rotation: -180 }] })).toEqual([1920, 1080]);
      expect(dims({ tags: { rotate: '0' } })).toEqual([1920, 1080]);
    });
  });

  it('没有视频流时报错', () => {
    expect(() => parseProbe({ format: { duration: '1' }, streams: [{ codec_type: 'audio' }] })).toThrow('没有视频流');
  });
});

describe('ffmpeg 集成', () => {
  it('probe 读取样片', async () => {
    const info = await probe(FIXTURE, cfg);
    expect(info.width).toBe(540);
    expect(info.height).toBe(960);
    expect(info.hasAudio).toBe(true);
    expect(info.durationSec).toBeGreaterThan(8);
  });

  it('extractWav16k 输出 16k 单声道 wav', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'mz-')), 'a.wav');
    await extractWav16k(FIXTURE, out, cfg);
    const info = statSync(out);
    expect(info.size).toBeGreaterThan(100_000);
  });
});
