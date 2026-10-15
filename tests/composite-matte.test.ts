import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildCutFilter, renderCut, videoSegment } from '../src/cut/render-cut.js';
import { closeEncoders, decoder, exited, forEachFrame, rawInput, startEncoder, tmpOf } from '../src/matting/ffmpeg-io.js';
import { compositeCut, compositeFilter, trimChain } from '../src/matting/composite-matte.js';
import { run, runBuffer } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';

const cfg = loadConfig({});
const STEP = 6;
const BASE = 20;

/** 每帧整体亮度（缩到 1×1 的灰度值），按帧顺序 */
const frameLevels = async (file: string): Promise<number[]> => [...await runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', file, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])];

interface SourceSpec { fps: number; offset: number; vfr?: boolean }

/**
 * 原片：1.2 秒、第 N 帧亮度 = 20 + 6N（帧号直接写在画面里），带音轨；offset 让视频流比音轨晚开始（文件起点仍是 0）；
 * vfr 时帧时间戳按正弦抖动（±10ms）并以可变帧率封装
 */
async function makeSource(dir: string, spec: SourceSpec): Promise<string> {
  const src = join(dir, `src-${spec.fps}-${spec.offset}-${spec.vfr ? 'vfr' : 'cfr'}.mp4`);
  const jitter = spec.vfr ? `,settb=1/1000,setpts='(N/${spec.fps}+0.01*sin(N))/TB'` : '';
  await run(cfg.ffmpeg, ['-v', 'error', '-y', '-itsoffset', String(spec.offset), '-f', 'lavfi', '-i', `color=c=black:s=64x64:r=${spec.fps}:d=1.2,geq=lum='${BASE}+${STEP}*N':cb=128:cr=128${jitter}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${1.2 + spec.offset}`, '-map', '0:v', '-map', '1:a', ...(spec.vfr ? ['-fps_mode', 'passthrough', '-enc_time_base', '1/1000', '-video_track_timescale', '1000'] : []),
    '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  return src;
}

/**
 * 模拟 matteVideo 的整条输出：同样的解码（fps=30）逐帧写前景与遮罩编码器；
 * fg / alpha 决定写原画面还是全白（255），用来分别检查前景与遮罩的取帧对齐
 */
async function makeLayers(src: string, dir: string, fg: 'source' | 'white', alpha: 'source' | 'white'): Promise<{ fgr: string; matte: string }> {
  const out = { fgr: join(dir, `fgr-${fg}-${alpha}.mp4`), matte: join(dir, `matte-${fg}-${alpha}.mp4`) };
  const fgrTmp = tmpOf(out.fgr);
  const matteTmp = tmpOf(out.matte);
  const encs = [
    startEncoder(cfg, [...rawInput('rgb24', 64, 64, 30), '-c:v', 'libx264rgb', '-crf', '0', '-pix_fmt', 'rgb24', fgrTmp], fgrTmp, out.fgr),
    startEncoder(cfg, [...rawInput('gray', 64, 64, 30), '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'gray', matteTmp], matteTmp, out.matte),
  ];
  const dec = decoder(cfg, src, 'fps=30');
  const done = exited(dec, '解码');
  await forEachFrame(dec, 64 * 64 * 3, async (frame) => {
    const gray = Buffer.from(Array.from({ length: 64 * 64 }, (_, i) => frame[i * 3]));
    await encs[0].write(fg === 'white' ? Buffer.alloc(frame.length, 255) : Buffer.from(frame));
    await encs[1].write(alpha === 'white' ? Buffer.alloc(gray.length, 255) : gray);
  });
  await done;
  await closeEncoders(encs);
  return out;
}

const black = async (dir: string): Promise<string> => {
  const bg = join(dir, 'black.png');
  await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64', '-frames:v', '1', bg]);
  return bg;
};

describe('compositeFilter / trimChain', () => {
  it('取帧串与 renderCut 是同一个函数（videoSegment）；增益写进调色', () => {
    const keep = [{ start: 0, end: 1 }, { start: 2.5, end: 3 }];
    const cutFilter = buildCutFilter(keep);
    const chain = trimChain('0:v', keep, 'v');
    keep.forEach((r, i) => {
      expect(cutFilter).toContain(videoSegment('0:v', r, `v${i}`));
      expect(chain).toContain(videoSegment('0:v', r, `v${i}`));
    });
    expect(videoSegment('1:v', keep[0], 'x')).toContain('fps=30:start_time=0');
    const f = compositeFilter({ w: 180, h: 320, blurSigma: 0, gains: [1.1, 1, 0.9], keep: [{ start: 0, end: 1 }] });
    expect(f).toContain('colorchannelmixer=rr=1.1000:gg=1.0000:bb=0.9000');
    expect(f).not.toContain('gblur');
    expect(() => trimChain('1:v', [], 'x')).toThrow('没有可保留的片段');
  });
});

describe('compositeCut（真实 ffmpeg）：前景、遮罩与剪切逐帧对齐', () => {
  const FROM_ZERO = [{ start: 0, end: 0.6 }, { start: 0.8, end: 1.1 }];
  const cases: { name: string; spec: SourceSpec; keep: { start: number; end: number }[] }[] = [
    { name: '29fps、起点 0、区间在中间', spec: { fps: 29, offset: 0 }, keep: [{ start: 0.2, end: 0.6 }, { start: 0.8, end: 1.1 }] },
    { name: '29fps、视频晚 0.5 秒开始、区间在视频起点之后', spec: { fps: 29, offset: 0.5 }, keep: [{ start: 0.7, end: 1.1 }, { start: 1.3, end: 1.6 }] },
    { name: '29fps、视频晚 0.5 秒开始、区间从 0 开始', spec: { fps: 29, offset: 0.5 }, keep: FROM_ZERO },
    { name: '30fps、视频晚 0.03 秒开始、区间从 0 开始', spec: { fps: 30, offset: 0.03 }, keep: FROM_ZERO },
    { name: '30fps、视频晚 0.07 秒开始、区间从 0 开始', spec: { fps: 30, offset: 0.07 }, keep: FROM_ZERO },
    { name: '24fps、视频晚 0.1 秒开始、区间从 0 开始', spec: { fps: 24, offset: 0.1 }, keep: FROM_ZERO },
    { name: '可变帧率、区间从 0 开始', spec: { fps: 30, offset: 0, vfr: true }, keep: FROM_ZERO },
    { name: '可变帧率、视频晚 0.07 秒开始', spec: { fps: 30, offset: 0.07, vfr: true }, keep: [{ start: 0, end: 0.5 }, { start: 0.7, end: 1.15 }] },
  ];
  for (const c of cases) {
    it(`${c.name}：帧数相等，逐帧内容一致`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mz-cc-'));
      const src = await makeSource(dir, c.spec);
      if (c.spec.vfr) expect((await probe(src, cfg)).fps).toBe(1000); // 真的是可变帧率（时基 1/1000，帧间隔不等）
      const cut = join(dir, 'cut.mp4');
      await renderCut(src, c.keep, cut, cfg);
      const bg = await black(dir);
      const expected = await frameLevels(cut);
      expect(expected.length).toBe(Math.round(c.keep.reduce((sum, r) => sum + r.end - r.start, 0) * 30));
      // 前景对齐：遮罩全白，输出就是前景；遮罩对齐：前景全白、背景全黑，输出亮度就是遮罩
      for (const [fg, alpha] of [['source', 'white'], ['white', 'source']] as const) {
        const layers = await makeLayers(src, dir, fg, alpha);
        const output = join(dir, `person-${fg}.mp4`);
        await compositeCut({ cut, ...layers, keep: c.keep, backgroundPath: bg, output, fgMean: null, cfg, blurSigma: 0 });
        const got = await frameLevels(output);
        expect(got.length).toBe(expected.length);
        got.forEach((v, i) => expect(Math.abs(v - expected[i]), `${fg}/${alpha} 第 ${i} 帧`).toBeLessThanOrEqual(STEP / 2));
        const info = await probe(output, cfg);
        expect([info.width, info.height, info.fps, info.hasAudio]).toEqual([64, 64, 30, true]);
      }
    });
  }

  it('输入不存在时中文报错；已取消时直接抛「已取消」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cc-bad-'));
    const base = { fgr: 'f', matte: 'm', keep: [{ start: 0, end: 1 }], backgroundPath: 'b', output: join(dir, 'o.mp4'), fgMean: null, cfg };
    await expect(compositeCut({ ...base, cut: join(dir, 'none.mp4') })).rejects.toThrow(/[一-龥]/);
    const c = new AbortController();
    c.abort();
    await expect(compositeCut({ ...base, cut: 'x', signal: c.signal })).rejects.toThrow('已取消');
  });
});
