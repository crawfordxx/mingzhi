import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRESETS, presetPath } from '../src/background/presets.js';
import { BG_IMAGE_MODEL, parseBackgroundArgs, resolveBackground } from '../src/background/resolve.js';
import { loadBackgroundRgb } from '../src/background/prepare.js';
import type { TaskClient, TaskInput } from '../src/llm/kexiang-task.js';
import { loadConfig } from '../src/config.js';

describe('presets', () => {
  it('10 张预设，文件都存在', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['study', 'studio', 'cafe', 'night-window', 'tech-dark', 'japanese', 'balcony', 'library', 'rooftop', 'concrete']);
    for (const p of PRESETS) expect(existsSync(presetPath(p.id))).toBe(true);
  });
  it('未知预设报错并列出可选 id', () => {
    expect(() => presetPath('beach')).toThrow('study');
  });
});

describe('parseBackgroundArgs', () => {
  it('预设 id、文件路径（相对 baseDir 解析）、一句话提示词', () => {
    expect(parseBackgroundArgs('study', undefined, '/u')).toEqual({ kind: 'preset', id: 'study' });
    expect(parseBackgroundArgs('bg/a.jpg', undefined, '/u')).toEqual({ kind: 'file', path: '/u/bg/a.jpg' });
    expect(parseBackgroundArgs(undefined, '海边日落', '/u')).toEqual({ kind: 'prompt', prompt: '海边日落' });
    expect(parseBackgroundArgs(undefined, undefined, '/u')).toBeUndefined();
  });
  it('同时给 --bg 和 --bg-prompt 报错；提示词为空白报错', () => {
    expect(() => parseBackgroundArgs('study', '海边', '/u')).toThrow('只能二选一');
    expect(() => parseBackgroundArgs(undefined, '  ', '/u')).toThrow('不能为空');
  });
});

describe('resolveBackground', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mz-bg-'));
  it('预设直接返回内置文件路径', async () => {
    expect(await resolveBackground({ kind: 'preset', id: 'cafe' }, dir)).toEqual({ spec: { kind: 'preset', id: 'cafe' }, path: presetPath('cafe') });
  });
  it('文件不存在时报错', async () => {
    await expect(resolveBackground({ kind: 'file', path: join(dir, 'nope.jpg') }, dir)).rejects.toThrow('背景图片不存在');
  });
  it('一句话生成：调用生图任务（竖版 2:3、1k、medium），下载到工作目录', async () => {
    const inputs: TaskInput[] = [];
    const urls: string[] = [];
    const task: TaskClient = { run: async (input) => { inputs.push(input); return { taskId: '1', url: 'https://x/bg.jpg' }; } };
    const res = await resolveBackground({ kind: 'prompt', prompt: '海边日落' }, dir, task, async (url, dest) => { urls.push(url); writeFileSync(dest, 'img'); });
    expect(urls).toEqual(['https://x/bg.jpg']);
    expect(res.path).toBe(join(dir, 'background.jpg'));
    expect(existsSync(res.path)).toBe(true);
    expect(inputs[0]).toMatchObject({ modelName: BG_IMAGE_MODEL, modelType: 'text2img', size: '2:3', resolution: '1k', quality: 'medium', output_format: 'jpeg' });
    expect(String(inputs[0].prompt)).toContain('海边日落');
    expect(String(inputs[0].prompt)).toContain('no people');
  });
  it('一句话生成但没有任务客户端时报错', async () => {
    await expect(resolveBackground({ kind: 'prompt', prompt: 'x' }, dir)).rejects.toThrow('MINGZHI_KX_KEY');
  });
});

describe('loadBackgroundRgb', () => {
  it('缩放裁切到视频尺寸并输出 rgb24（宽×高×3 字节），虚化不改变尺寸', async () => {
    const cfg = loadConfig({});
    const sharp = await loadBackgroundRgb(presetPath('study'), 90, 160, 0, cfg);
    const blurred = await loadBackgroundRgb(presetPath('study'), 90, 160, 8, cfg);
    expect(sharp.length).toBe(90 * 160 * 3);
    expect(blurred.length).toBe(90 * 160 * 3);
    expect(blurred.equals(sharp)).toBe(false);
  });
});
