import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 只记录 Remotion 收到的参数，不真的打包、开浏览器
const calls = vi.hoisted(() => ({ select: [] as unknown[], media: [] as unknown[], still: [] as unknown[], ensure: [] as unknown[] }));

vi.mock('@remotion/bundler', () => ({
  bundle: async () => mkdtempSync(join(tmpdir(), 'mz-fake-bundle-')),
}));
vi.mock('@remotion/renderer', () => ({
  makeCancelSignal: () => ({ cancelSignal: () => undefined, cancel: () => undefined }),
  selectComposition: async (o: unknown) => {
    calls.select.push(o);
    return { id: 'x', width: 1, height: 1, fps: 30, durationInFrames: 1 };
  },
  renderMedia: async (o: { outputLocation: string }) => {
    calls.media.push(o);
    writeFileSync(o.outputLocation, 'x');
  },
  renderStill: async (o: unknown) => {
    calls.still.push(o);
  },
  ensureBrowser: async (o: unknown) => {
    calls.ensure.push(o);
    return { type: 'no-browser' };
  },
}));
vi.mock('../src/media/exec.js', () => ({ run: async () => '' }));

const { browserOptions } = await import('../src/compose/browser.js');
const render = await import('../src/compose/render.js');
const { screenshotUrl } = await import('../src/broll/screenshot.js');

const ROOT = join(import.meta.dirname, '..');
const CHROME = '/opt/mingzhi/runtime/chrome-headless-shell/149.0.7790.0/mac-arm64/chrome-headless-shell';
const props = { shots: [] } as never;

/** 跑一遍服务端所有用到 Remotion 浏览器的入口 */
async function callEverything(dir: string): Promise<void> {
  await render.renderTalk({ workDir: dir, props, output: join(dir, 'a.mp4'), concurrency: 1 });
  await render.renderCardStill({ workDir: dir, card: { template: 'title', props: {} } as never, output: join(dir, 'c.png') });
  await render.renderCardFrames(dir, { template: 'title', props: {} } as never, 2, 'ffmpeg');
  await render.renderCaptionStill({ workDir: dir, captionStyle: 'classic' as never, captionFontFile: 'f.ttf', text: '字', output: join(dir, 'cap.png') });
  await render.renderCoverStills(dir, [{ id: 'Cover34', props: {} as never, output: join(dir, 'cv.png') }]);
  await render.renderVideoSegment({ serveUrl: dir, props, output: join(dir, 's.mp4'), startFrame: 0, endFrame: 2, concurrency: 1 });
  await render.renderAudioTrack({ serveUrl: dir, props, output: join(dir, 'a.m4a'), concurrency: 1 });
  const page = join(dir, 'p.html');
  writeFileSync(page, '<html></html>');
  await expect(screenshotUrl(pathToFileURL(page).href, join(dir, 'p.png'), { allowFile: true })).rejects.toThrow('无头浏览器');
}

const allCalls = (): unknown[] => [...calls.select, ...calls.media, ...calls.still, ...calls.ensure];

describe('browserOptions', () => {
  it('设了 MINGZHI_CHROME 时给出 browserExecutable', () => {
    expect(browserOptions({ MINGZHI_CHROME: CHROME })).toEqual({ browserExecutable: CHROME });
  });

  it('未设置或为空时不带任何字段（Remotion 照旧自己找浏览器）', () => {
    expect(browserOptions({})).toEqual({});
    expect(browserOptions({ MINGZHI_CHROME: '' })).toEqual({});
  });
});

describe('源码扫描：以后新增的 Remotion 浏览器调用也必须带 browserOptions()', () => {
  it('src/ 里每处 selectComposition / renderMedia / renderStill / renderFrames / getCompositions / ensureBrowser / openBrowser 调用都展开了 browserOptions()', () => {
    const files = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
    const calls: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(ROOT, 'src', f), 'utf8');
      for (const m of text.matchAll(/\b(selectComposition|renderMedia|renderStill|renderFrames|getCompositions|ensureBrowser|openBrowser)\(/g)) {
        const head = text.slice(m.index, m.index + m[0].length + 30);
        calls.push(`${f}: ${head.replace(/\s+/g, ' ')}`);
        expect(head, `${f} 里的 ${m[1]} 调用没有 browserOptions()`).toContain('browserOptions()');
      }
    }
    expect(calls.length).toBeGreaterThanOrEqual(15);
  });
});

describe('Remotion 调用带上启动器的 Chrome', () => {
  const saved = process.env.MINGZHI_CHROME;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mz-chrome-'));
    for (const list of Object.values(calls)) list.length = 0;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MINGZHI_CHROME;
    else process.env.MINGZHI_CHROME = saved;
  });

  it('MINGZHI_CHROME 存在时 selectComposition / renderMedia / renderStill / ensureBrowser 都传 browserExecutable', async () => {
    process.env.MINGZHI_CHROME = CHROME;
    await callEverything(dir);
    expect(calls.select.length).toBeGreaterThanOrEqual(7);
    expect(calls.media).toHaveLength(3);
    expect(calls.still.length).toBeGreaterThanOrEqual(6);
    expect(calls.ensure).toHaveLength(1);
    for (const c of allCalls()) expect(c).toMatchObject({ browserExecutable: CHROME });
  });

  it('未设置时不传 browserExecutable，行为不变', async () => {
    delete process.env.MINGZHI_CHROME;
    await callEverything(dir);
    expect(allCalls().length).toBeGreaterThan(10);
    for (const c of allCalls()) expect(c === undefined || !Object.hasOwn(c as object, 'browserExecutable')).toBe(true);
  });
});
