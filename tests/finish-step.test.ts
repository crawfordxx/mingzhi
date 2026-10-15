import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fontsReady, loadTracks, musicReady } from '../src/assets/catalog.js';
import { loadConfig } from '../src/config.js';
import { prepareAudio, validateAudio } from '../src/pipeline/audio-step.js';
import { parseFinishArgs, runCover } from '../src/pipeline/finish-step.js';
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

describe('参数校验', () => {
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

  it('生成失败：降级并写明原因；成功：用分镜给的标题，记录两张封面路径', async () => {
    const failing = record();
    await runCover({ ...ctx, coverDeps: { makeCovers: async () => { throw new Error('额度不足'); } } }, { style: 'neon' }, sb, caps, '/tmp/w/cut.mp4', failing.complete);
    expect(failing.events[0].message).toContain('额度不足');
    const seen: { title: string; subtitle?: string; personVideo: string }[] = [];
    const ok = record();
    const makeCovers = async (o: { title: string; subtitle?: string; personVideo: string }) => {
      seen.push(o);
      return { cover34: '/tmp/w/cover-3x4.png', cover43: '/tmp/w/cover-4x3.png', attempts: 2, costYuan: 1.2, unverified: [], person: true };
    };
    const withTitle: Storyboard = { ...sb, coverTitle: { title: '取得到才算钱', subtitle: '应急金' } };
    await runCover({ ...ctx, coverDeps: { makeCovers: makeCovers as never } }, undefined, withTitle, caps, '/tmp/w/cut.mp4', ok.complete);
    expect(seen[0]).toMatchObject({ title: '取得到才算钱', subtitle: '应急金', personVideo: '/tmp/w/cut.mp4' });
    expect(ok.events[0].patch?.artifacts).toEqual({ cover34: '/tmp/w/cover-3x4.png', cover43: '/tmp/w/cover-4x3.png' });
    // 分镜没给标题：用 hook 卡片标题兜底
    await runCover({ ...ctx, coverDeps: { makeCovers: makeCovers as never } }, undefined, sb, caps, '/tmp/w/cut.mp4', ok.complete);
    expect(seen[1].title).toBe('钱要放在取得到的地方');
  });

  it('cover: false 什么都不做', async () => {
    const { events, complete } = record();
    await runCover(ctx, false, sb, caps, 'x', complete);
    expect(events).toEqual([]);
  });
});

