import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadedTracks, fontsReady, loadTracks, musicReady, trackPath } from '../src/assets/catalog.js';
import { loadConfig } from '../src/config.js';
import { CostMeter } from '../src/cost/meter.js';
import { FALLBACK_PRICES } from '../src/cost/prices.js';
import { prepareAudio, validateAudio } from '../src/pipeline/audio-step.js';
import { parseFinishArgs, runCover, runLoudness, validateStyles } from '../src/pipeline/finish-step.js';
import type { ProjectFile, ProjectPatch } from '../src/pipeline/project.js';
import type { Storyboard } from '../src/storyboard/schema.js';

const sb: Storyboard = { bgm: 'tech', shots: [
  { start: 0, end: 4, layout: 'split', card: { template: 'hook', props: { index: 1, total: 1, headline: '钱要放在取得到的地方', highlight: [] } } },
  { start: 4, end: 8, layout: 'full' },
] };
const caps = [{ start: 0, end: 3, text: '你好' }];
/** 空数据目录：配乐与字体都未下载 */
const emptyCfg = () => ({ ...loadConfig({}), dataDir: mkdtempSync(join(tmpdir(), 'mz-empty-')) });

describe('prepareAudio', () => {
  it('素材未下载：不报错，无配乐、字体回退为空，提示运行 pnpm fetch-assets', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-au-'));
    const plan = await prepareAudio({ workDir, cfg: emptyCfg(), input: 'a.mp4', captionStyle: 'blade' }, sb, caps, 8);
    expect(plan.props.bgm).toBeUndefined();
    expect(plan.props).toMatchObject({ captionStyle: 'blade', captionFontFile: '' });
    expect(plan.info).toMatchObject({ track: null, mood: 'tech' });
    expect(plan.info.sfxCount).toBe(plan.props.sfx?.length);
    expect(plan.notes).toHaveLength(2);
    for (const note of plan.notes) expect(note).toContain('pnpm fetch-assets');
  });

  it('--bgm none：即使素材齐全也不加背景乐，不再提示下载配乐', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-au-'));
    const plan = await prepareAudio({ workDir, cfg: emptyCfg(), input: 'a.mp4', audio: { bgm: 'none' } }, sb, caps, 8);
    expect(plan.info.track).toBeNull();
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toContain('字体');
  });

  it.skipIf(!musicReady(loadConfig({})) || !fontsReady(loadConfig({})))('素材齐全：按情绪选曲并落盘，字幕样式与字体并入渲染字段', async () => {
    const cfg = loadConfig({});
    const workDir = mkdtempSync(join(tmpdir(), 'mz-au-'));
    const plan = await prepareAudio({ workDir, cfg, input: 'a.mp4', captionStyle: 'blade' }, sb, caps, 8);
    expect(loadTracks().find((t) => t.id === plan.info.track)?.mood).toBe('tech');
    expect(plan.props.bgm).toMatchObject({ file: 'audio/bgm.mp3' });
    expect(plan.props.bgm?.keys.length).toBeGreaterThan(1);
    expect(existsSync(join(workDir, 'audio/bgm.mp3'))).toBe(true);
    expect(plan.props.captionFontFile).not.toBe('');
    expect(existsSync(join(workDir, 'fonts', plan.props.captionFontFile ?? ''))).toBe(true);
    expect(plan.notes).toEqual([]);
    const pinned = await prepareAudio({ workDir, cfg, input: 'a.mp4', audio: { bgm: loadTracks()[0].id } }, sb, caps, 8);
    expect(pinned.info.track).toBe(loadTracks()[0].id);
  });
});

/** 给空数据目录放几首假曲目（非空文件即视为已下载） */
function cfgWithTracks(ids: string[]) {
  const cfg = emptyCfg();
  for (const t of loadTracks().filter((x) => ids.includes(x.id))) {
    mkdirSync(join(cfg.dataDir, 'assets', 'music'), { recursive: true });
    writeFileSync(trackPath(cfg, t), 'fake-mp3');
  }
  return cfg;
}

describe('配乐素材就绪判断', () => {
  const [a, b] = loadTracks();

  it('--bgm <id>：只要所选曲目已下载就行，不要求全部下载', () => {
    const cfg = cfgWithTracks([a.id]);
    expect(musicReady(cfg, a.id)).toBe(true);
    expect(musicReady(cfg, b.id)).toBe(false);
    expect(musicReady(cfg)).toBe(false);
  });

  it('auto：至少一首已下载即可，选曲只在已下载的曲目里挑（同情绪没有就退到任意已下载曲目）', async () => {
    const other = loadTracks().find((t) => t.mood !== 'tech')!;
    const cfg = cfgWithTracks([other.id]);
    expect(musicReady(cfg, 'auto')).toBe(true);
    expect(downloadedTracks(cfg).map((t) => t.id)).toEqual([other.id]);
    const workDir = mkdtempSync(join(tmpdir(), 'mz-au-'));
    const plan = await prepareAudio({ workDir, cfg, input: 'a.mp4' }, sb, caps, 8);
    expect(plan.info.track).toBe(other.id);
    expect(plan.props.bgm).toMatchObject({ file: 'audio/bgm.mp3' });
    expect(musicReady(emptyCfg(), 'auto')).toBe(false);
  });

  it('--bgm 指定的曲目没下载：降级为无配乐并提示 fetch-assets', async () => {
    const cfg = cfgWithTracks([a.id]);
    const plan = await prepareAudio({ workDir: mkdtempSync(join(tmpdir(), 'mz-au-')), cfg, input: 'a.mp4', audio: { bgm: b.id } }, sb, caps, 8);
    expect(plan.info.track).toBeNull();
    expect(plan.notes[0]).toContain('pnpm fetch-assets');
  });
});

describe('参数校验', () => {
  it('validateStyles：constructor / toString 这类原型链上的名字也按未知处理', () => {
    expect(() => validateStyles('constructor' as never, undefined)).toThrow('未知字幕样式');
    expect(() => validateStyles(undefined, { style: 'toString' as never })).toThrow('未知封面风格');
    expect(() => validateStyles('blade', { style: 'neon' })).not.toThrow();
  });

  it('validateAudio：未知曲目报错并列出可选项', () => {
    expect(() => validateAudio({ bgm: 'nope' })).toThrow('未知曲目');
    expect(() => validateAudio({ bgm: 'none' })).not.toThrow();
    expect(() => validateAudio(undefined)).not.toThrow();
  });

  it('parseFinishArgs：默认 auto + bauhaus 封面；--no-cover 关闭；非法 id 报错', () => {
    expect(parseFinishArgs({})).toEqual({ audio: { bgm: 'auto' }, cover: { style: 'bauhaus' } });
    expect(parseFinishArgs({ bgm: 'none', 'caption-style': 'blade', 'no-cover': true })).toEqual({ audio: { bgm: 'none' }, captionStyle: 'blade', cover: false });
    expect(() => parseFinishArgs({ 'caption-style': 'zzz' })).toThrow('未知字幕样式');
    expect(() => parseFinishArgs({ 'cover-style': 'zzz' })).toThrow('未知封面风格');
    expect(() => parseFinishArgs({ bgm: 'zzz' })).toThrow('未知曲目');
  });
});

describe('runCover', () => {
  const record = () => {
    const events: { step: string; message: string; patch?: ProjectPatch }[] = [];
    return { events, complete: (step: 'loudness' | 'cover', message: string, patch?: ProjectPatch): ProjectFile => { events.push({ step, message, patch }); return {} as ProjectFile; } };
  };
  const ctx = { workDir: '/tmp/w', cfg: loadConfig({}), llm: { chatJson: async () => ({}) } };

  it('没有 task 也没有注入实现：降级为一条提示，不抛错', async () => {
    const { events, complete } = record();
    await runCover(ctx, undefined, sb, caps, '/tmp/w/cut.mp4', complete);
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain('封面生成失败');
    expect(events[0].message).toContain('MINGZHI_KX_KEY');
    expect(events[0].patch).toBeUndefined();
  });

  it('预算不够封面（剩余 < ¥1.25）：不调用封面实现，降级为一条「预算不足」提示', async () => {
    const meter = new CostMeter(FALLBACK_PRICES, 2);
    meter.addTask('image', 1, '前序');
    const makeCovers = vi.fn();
    const { events, complete } = record();
    await runCover({ ...ctx, meter, coverDeps: { makeCovers: makeCovers as never } }, undefined, sb, caps, 'x', complete);
    expect(makeCovers).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain('预算不足，已跳过封面');
    expect(events[0].message).toContain('剩余 ¥1.00');
  });

  it('预算刚好够封面（¥1.25）时照常生成', async () => {
    const meter = new CostMeter(FALLBACK_PRICES, 1.25);
    const makeCovers = vi.fn(async () => ({ cover34: 'a', cover43: 'b', attempts: 2, costYuan: 1.2, unverified: [], person: true, reused: [] }));
    const { events, complete } = record();
    await runCover({ ...ctx, meter, coverDeps: { makeCovers: makeCovers as never } }, undefined, sb, caps, 'x', complete);
    expect(makeCovers).toHaveBeenCalledTimes(1);
    expect(makeCovers).toHaveBeenCalledWith(expect.objectContaining({ meter })); // 生图前逐次查预算要用它
    expect(events.at(-1)?.message).toContain('封面已生成');
  });

  it('生成失败：降级并写明原因；成功：用分镜给的标题，记录两张封面路径', async () => {
    const failing = record();
    await runCover({ ...ctx, coverDeps: { makeCovers: async () => { throw new Error('额度不足'); } } }, { style: 'neon' }, sb, caps, '/tmp/w/cut.mp4', failing.complete);
    expect(failing.events[0].message).toContain('生成封面中');
    expect(failing.events[0].message).toContain('约 2 分钟');
    expect(failing.events.at(-1)?.message).toContain('额度不足');
    const seen: { title: string; subtitle?: string; personVideo: string }[] = [];
    const ok = record();
    const makeCovers = async (o: { title: string; subtitle?: string; personVideo: string }) => {
      seen.push(o);
      return { cover34: '/tmp/w/cover-3x4.png', cover43: '/tmp/w/cover-4x3.png', attempts: 2, costYuan: 1.2, unverified: [], person: true, reused: [] };
    };
    const withTitle: Storyboard = { ...sb, coverTitle: { title: '取得到才算钱', subtitle: '应急金' } };
    await runCover({ ...ctx, coverDeps: { makeCovers: makeCovers as never } }, undefined, withTitle, caps, '/tmp/w/cut.mp4', ok.complete);
    expect(seen[0]).toMatchObject({ title: '取得到才算钱', subtitle: '应急金', personVideo: '/tmp/w/cut.mp4' });
    expect(ok.events[0].message).toContain('生成封面中');
    expect(ok.events[1].patch?.artifacts).toEqual({ cover34: '/tmp/w/cover-3x4.png', cover43: '/tmp/w/cover-4x3.png' });
    expect(ok.events[1].patch?.cover).toEqual({ style: 'bauhaus', costYuan: 1.2, unverified: [], reused: [] });
    // 分镜没给标题：用 hook 卡片标题兜底
    await runCover({ ...ctx, coverDeps: { makeCovers: makeCovers as never } }, undefined, sb, caps, '/tmp/w/cut.mp4', ok.complete);
    expect(seen[1].title).toBe('钱要放在取得到的地方');
  });

  it('复用底图在摘要里说明；-o 在工作目录之外时封面复制到成片旁边并列出路径', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-cv-'));
    const outDir = mkdtempSync(join(tmpdir(), 'mz-out-'));
    const cover34 = join(workDir, 'cover-3x4.png');
    const cover43 = join(workDir, 'cover-4x3.png');
    writeFileSync(cover34, 'a');
    writeFileSync(cover43, 'b');
    const makeCovers = async () => ({ cover34, cover43, attempts: 0, costYuan: 0, unverified: [], person: true, reused: ['3:4', '4:3'] });
    const { events, complete } = record();
    await runCover({ ...ctx, workDir, output: join(outDir, '我的视频_精剪.mp4'), coverDeps: { makeCovers: makeCovers as never } }, { style: 'neon' }, sb, caps, 'x', complete);
    const msg = events[1].message;
    expect(msg).toContain('复用已有底图');
    expect(existsSync(join(outDir, '我的视频_精剪_封面3x4.png'))).toBe(true);
    expect(existsSync(join(outDir, '我的视频_精剪_封面4x3.png'))).toBe(true);
    expect(msg).toContain(join(outDir, '我的视频_精剪_封面3x4.png'));
    expect(events[1].patch?.cover).toMatchObject({ style: 'neon', reused: ['3:4', '4:3'] });
    // 成片就在工作目录里：不复制
    const inside = record();
    await runCover({ ...ctx, workDir, output: join(workDir, 'x_精剪.mp4'), coverDeps: { makeCovers: makeCovers as never } }, undefined, sb, caps, 'x', inside.complete);
    expect(existsSync(join(workDir, 'x_精剪_封面3x4.png'))).toBe(false);
  });

  it('cover: false 什么都不做', async () => {
    const { events, complete } = record();
    await runCover(ctx, false, sb, caps, 'x', complete);
    expect(events).toEqual([]);
  });
});


describe('runLoudness', () => {
  it('开始前清掉遗留的 output：这次失败后不会留下上一次的旧文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-ld-'));
    const raw = join(dir, 'final.raw.mp4');
    const output = join(dir, 'out.mp4');
    writeFileSync(raw, 'not a real video');
    writeFileSync(output, 'old result');
    const events: string[] = [];
    await expect(runLoudness({ ...loadConfig({}), ffprobe: '/nonexistent/ffprobe' }, raw, output, (_step, message) => { events.push(message); return {} as ProjectFile; })).rejects.toThrow('响度统一失败');
    expect(existsSync(output)).toBe(false);
    expect(existsSync(raw)).toBe(true);
    expect(events).toEqual([]);
  });
});
