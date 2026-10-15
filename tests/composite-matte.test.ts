import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { renderCut } from '../src/cut/render-cut.js';
import { closeEncoders, decoder, exited, forEachFrame, rawInput, startEncoder, tmpOf } from '../src/matting/ffmpeg-io.js';
import { compositeCut, compositeFilter, trimChain } from '../src/matting/composite-matte.js';
import { run, runBuffer } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';

const cfg = loadConfig({});
const STEP = 6;

/** 每帧整体亮度（缩到 1×1 的灰度值），按帧顺序 */
const frameLevels = async (file: string): Promise<number[]> => [...await runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', file, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])];

/** 原片：29fps、1.4 秒、第 N 帧亮度 = 10 + 6N（帧号直接写在画面里），带音轨；offset 让视频流比音轨晚开始（文件起点仍是 0） */
async function makeSource(dir: string, offset: number): Promise<string> {
  const src = join(dir, `src-${offset}.mp4`);
  await run(cfg.ffmpeg, ['-v', 'error', '-y', '-itsoffset', String(offset), '-f', 'lavfi', '-i', `color=c=black:s=64x64:r=29:d=1.4,geq=lum='10+${STEP}*N':cb=128:cr=128`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${1.4 + offset}`, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
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
  it('取帧链与 renderCut 相同（fps=30、取偶、trim、重置时间戳）；增益写进调色', () => {
    expect(trimChain('1:v', [{ start: 1, end: 2 }], 'fg')).toBe('[1:v]fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,trim=start=1:end=2,setpts=PTS-STARTPTS[fg0];[fg0]concat=n=1:v=1:a=0,setpts=N/(30*TB)[fg]');
    const f = compositeFilter({ w: 180, h: 320, blurSigma: 0, gains: [1.1, 1, 0.9], keep: [{ start: 0, end: 1 }] });
    expect(f).toContain('colorchannelmixer=rr=1.1000:gg=1.0000:bb=0.9000');
    expect(f).not.toContain('gblur');
    expect(() => trimChain('1:v', [], 'x')).toThrow('没有可保留的片段');
  });
});

describe('compositeCut（真实 ffmpeg）：前景、遮罩与剪切逐帧对齐', () => {
  for (const offset of [0, 0.5]) {
    it(`原片 29fps、视频起始 ${offset} 秒：帧数相等，每帧亮度一致`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mz-cc-'));
      const src = await makeSource(dir, offset);
      const keep = [{ start: offset + 0.2, end: offset + 0.6 }, { start: offset + 0.8, end: offset + 1.3 }];
      const cut = join(dir, 'cut.mp4');
      await renderCut(src, keep, cut, cfg);
      const bg = await black(dir);
      const expected = await frameLevels(cut);
      expect(expected.length).toBe(27); // 0.4 + 0.5 秒 × 30
      // 前景对齐：遮罩全白，输出就是前景；遮罩对齐：前景全白、背景全黑，输出亮度就是遮罩
      for (const [fg, alpha] of [['source', 'white'], ['white', 'source']] as const) {
        const layers = await makeLayers(src, dir, fg, alpha);
        const output = join(dir, `person-${fg}.mp4`);
        await compositeCut({ cut, ...layers, keep, backgroundPath: bg, output, fgMean: null, cfg, blurSigma: 0 });
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
