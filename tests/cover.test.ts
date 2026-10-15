import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import type { ChatOptions, LlmClient } from '../src/llm/kexiang.js';
import type { TaskClient, TaskInput } from '../src/llm/kexiang-task.js';
import type { Storyboard } from '../src/storyboard/schema.js';
import { COVER_STYLES, DEFAULT_COVER_STYLE, slotRegion, type CoverStyleId } from '../src/cover/styles.js';
import { COVER_MODEL, coverPrompt, coverTitle, generateCoverArt, generateVerifiedArt, makeCovers, normalizeTitle, verifyTitle } from '../src/cover/generate.js';
import { candidateTimes, cutoutPerson, cutoutPersonWithRetry, pickPersonFrame } from '../src/cover/person.js';
import { cutoutRgba } from '../src/matting/rvm.js';
import { hasRvm } from './helpers/models.js';

const IDS = Object.keys(COVER_STYLES) as CoverStyleId[];
const cfg = loadConfig({});

/** 假 LLM：按调用顺序返回预设结果（函数则抛错），并记录请求 */
function fakeLlm(replies: (unknown | (() => never))[]): LlmClient & { calls: ChatOptions[] } {
  const calls: ChatOptions[] = [];
  return {
    calls,
    async chatJson(opts) {
      calls.push(opts);
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      return typeof r === 'function' ? (r as () => never)() : r;
    },
  };
}

/** 假任务客户端：记录输入，返回固定地址与花费 */
function fakeTask(cost: number | null = 0.6): TaskClient & { inputs: TaskInput[] } {
  const inputs: TaskInput[] = [];
  return { inputs, async run(input) { inputs.push(input); return { taskId: String(inputs.length), url: `https://img.example/${inputs.length}.png`, ...(cost === null ? {} : { cost }) }; } };
}

/** 假下载：用 lavfi 生成纯色 PNG（尺寸接近 GPT Image 2 的 1k 输出） */
const pngDownload = async (_url: string, dest: string): Promise<void> => {
  await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xE8D9B0:s=768x1024', '-frames:v', '1', dest]);
};

async function makeVideo(dir: string, sec = 3): Promise<string> {
  const out = join(dir, 'clip.mp4');
  await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=360x640:r=30:d=${sec}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

const dims = async (file: string): Promise<number[]> =>
  (await run(cfg.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])).stdout.trim().split(',').map(Number);

const pixFmt = async (file: string): Promise<string> =>
  (await run(cfg.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'default=nw=1:nk=1', file])).stdout.trim();

describe('封面风格表', () => {
  it('10 套，默认包豪斯；每套有中文名与风格描述', () => {
    expect(IDS).toEqual(['bauhaus', 'swiss', 'memphis', 'editorial', 'neon', 'guochao', 'risograph', 'neobrutal', 'y2k', 'japanese']);
    expect(DEFAULT_COVER_STYLE).toBe('bauhaus');
    for (const id of IDS) {
      expect(COVER_STYLES[id].name.length, id).toBeGreaterThan(0);
      expect(COVER_STYLES[id].prompt.length, id).toBeGreaterThan(20);
    }
  });

  it('人物放置区都在画布内（0–1）且到底边', () => {
    for (const id of IDS) {
      const { x, y, w, h } = COVER_STYLES[id].personSlot;
      for (const v of [x, y, w, h]) expect(v, id).toBeGreaterThanOrEqual(0);
      expect(x + w, id).toBeLessThanOrEqual(1);
      expect(y + h, id).toBeCloseTo(1);
      expect(w * h, id).toBeGreaterThan(0.2);
    }
  });

  it('留白方位与设计一致', () => {
    const blank = (id: CoverStyleId): string => slotRegion(COVER_STYLES[id].personSlot).blank;
    for (const id of ['bauhaus', 'neon', 'risograph', 'neobrutal'] as const) expect(blank(id), id).toBe('右下角');
    for (const id of ['swiss', 'editorial', 'guochao', 'japanese'] as const) expect(blank(id), id).toBe('右侧');
    for (const id of ['memphis', 'y2k'] as const) expect(blank(id), id).toBe('底部居中');
    expect(slotRegion({ x: 0, y: 0.3, w: 0.5, h: 0.7 })).toEqual({ blank: '左下角', title: '右上角' });
  });

  it('人物修饰：霓虹青色描边光、新粗野 8px 黑描边与硬投影、孔版双色调', () => {
    expect(COVER_STYLES.neon.personStyle.outline?.color).toBe('#22E5FF');
    expect(COVER_STYLES.neobrutal.personStyle).toMatchObject({ outline: { px: 8, color: '#000000' }, shadow: '14px 14px 0 #000000' });
    expect(COVER_STYLES.risograph.personStyle.duotone).toHaveLength(2);
  });
});

describe('coverPrompt', () => {
  it('含风格描述、标题原文、小标题、留白方位、比例与「不要出现人物」', () => {
    const p = coverPrompt('bauhaus', 'FDE 是什么岗位？', 'AI 落地的关键角色', '3:4');
    expect(p).toContain(COVER_STYLES.bauhaus.prompt);
    expect(p).toContain('「FDE 是什么岗位？」');
    expect(p).toContain('逐字');
    expect(p).toContain('「AI 落地的关键角色」');
    expect(p).toContain('右下角留出一大片干净的空白区域');
    expect(p).toContain('左上角');
    expect(p).toContain('竖版 3:4');
    expect(p).toContain('不要出现任何人物、人脸、手');
    expect(p).toContain('无水印');
  });

  it('人物在右侧/右下时，要求标题限制在左侧约 45% 宽度内、可折成 2–3 行', () => {
    for (const id of ['bauhaus', 'swiss', 'neon', 'japanese'] as const) {
      const p = coverPrompt(id, '标题', undefined, '4:3');
      expect(p, id).toContain('左侧约 45% 的宽度内');
      expect(p, id).toContain('2–3 行');
    }
  });

  it('每套风格的留白方位都写进提示词；横版写 4:3；没有小标题时不提小字', () => {
    for (const id of IDS) expect(coverPrompt(id, '标题', undefined, '4:3'), id).toContain(`${slotRegion(COVER_STYLES[id].personSlot).blank}留出`);
    expect(coverPrompt('memphis', '标题', undefined, '3:4')).not.toContain('45%');
    const p = coverPrompt('swiss', '标题', undefined, '4:3');
    expect(p).toContain('横版 4:3');
    expect(p).not.toContain('小字');
  });
});

describe('generateCoverArt', () => {
  it('调用 GPT-Image-2-Official 文生图（对应比例、1k、medium、png），下载到目标路径并返回花费', async () => {
    const task = fakeTask(0.6);
    const downloads: [string, string][] = [];
    const res = await generateCoverArt(task, 'neon', '标题', '小标题', '4:3', '/tmp/x.png', async (u, d) => { downloads.push([u, d]); });
    expect(COVER_MODEL).toBe('GPT-Image-2-Official');
    expect(task.inputs[0]).toEqual({ modelName: COVER_MODEL, modelType: 'text2img', prompt: coverPrompt('neon', '标题', '小标题', '4:3'), size: '4:3', resolution: '1k', quality: 'medium', output_format: 'png' });
    expect(downloads).toEqual([['https://img.example/1.png', '/tmp/x.png']]);
    expect(res).toEqual({ cost: 0.6 });
  });
});

describe('verifyTitle', () => {
  it('归一化：去空格与标点、全角转半角、拉丁字母不分大小写', () => {
    expect(normalizeTitle(' ＦＤＥ 是什么岗位？')).toBe('fde是什么岗位');
    expect(normalizeTitle('「AI」落地，真难!')).toBe('ai落地真难');
    expect(normalizeTitle('AI+教育 ¥99 → 爆款★')).toBe('ai教育99爆款');
  });

  it('把图片以 data URI 发给读图模型：相等为 ok，不等或答非所问为 mismatch，模型出错为 error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cover-v-'));
    const png = join(dir, 'a.png');
    await pngDownload('', png);
    const llm = fakeLlm([{ title: 'fde 是什么岗位?' }]);
    expect(await verifyTitle(llm, png, 'FDE是什么岗位？')).toBe('ok');
    expect(llm.calls[0].images?.[0]).toMatch(/^data:image\/png;base64,iVBOR/);
    expect(await verifyTitle(fakeLlm([{ title: 'FDE是什么岗味' }]), png, 'FDE是什么岗位？')).toBe('mismatch');
    expect(await verifyTitle(fakeLlm([{ text: 'x' }]), png, '标题')).toBe('mismatch');
    expect(await verifyTitle(fakeLlm([() => { throw new Error('网络错误'); }]), png, '标题')).toBe('error');
  });
});

describe('generateVerifiedArt', () => {
  it('标题核对不通过时重生一次，仍不通过保留第二次结果并标注未通过；花费累计', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cover-g-'));
    const dest = join(dir, 'art.png');
    const task = fakeTask(0.6);
    const res = await generateVerifiedArt({ task, client: fakeLlm([{ title: '错字' }]), style: 'bauhaus', title: '标题', aspect: '3:4', dest, download: pngDownload });
    expect(res).toEqual({ attempts: 2, costYuan: 1.2, verified: false, check: 'mismatch', reused: false });
    expect(task.inputs).toHaveLength(2);
    expect(existsSync(dest)).toBe(true);
  });

  it('第一次通过就不再重生；任务没有返回花费时按 0 计', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cover-g1-'));
    const res = await generateVerifiedArt({ task: fakeTask(null), client: fakeLlm([{ title: '标题' }]), style: 'y2k', title: '标题', aspect: '4:3', dest: join(dir, 'a.png'), download: pngDownload });
    expect(res).toEqual({ attempts: 1, costYuan: 0, verified: true, check: 'ok', reused: false });
  });

  it('核对模型出错时不重生：只生成一次，保留第一张并标注未核对', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cover-ge-'));
    const task = fakeTask(0.6);
    const res = await generateVerifiedArt({ task, client: fakeLlm([() => { throw new Error('超时'); }]), style: 'neon', title: '标题', aspect: '3:4', dest: join(dir, 'a.png'), download: pngDownload });
    expect(res).toEqual({ attempts: 1, costYuan: 0.6, verified: false, check: 'error', reused: false });
    expect(task.inputs).toHaveLength(1);
  });

  it('下载成功后写旁注；同风格同标题再跑时复用底图不再生成，标题变了则重新生成', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cover-gr-'));
    const dest = join(dir, 'cover-art-3x4.png');
    const base = { style: 'bauhaus' as const, title: '标题', subtitle: '小字', aspect: '3:4' as const, dest, download: pngDownload };
    await generateVerifiedArt({ ...base, task: fakeTask(0.6), client: fakeLlm([{ title: '标题' }]) });
    expect(JSON.parse(readFileSync(join(dir, 'cover-art-3x4.json'), 'utf8'))).toEqual({ style: 'bauhaus', title: '标题', subtitle: '小字', aspect: '3:4', verified: true });
    const again = fakeTask(0.6);
    const llm = fakeLlm([{ title: '标题' }]);
    expect(await generateVerifiedArt({ ...base, task: again, client: llm })).toEqual({ attempts: 0, costYuan: 0, verified: true, check: 'ok', reused: true });
    expect(again.inputs).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);
    const changed = fakeTask(0.6);
    const res = await generateVerifiedArt({ ...base, title: '新标题', task: changed, client: fakeLlm([{ title: '新标题' }]) });
    expect([res.attempts, res.reused, changed.inputs.length]).toEqual([1, false, 1]);
  });

  it('旁注损坏或缺失时不复用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cover-gc-'));
    const dest = join(dir, 'cover-art-4x3.png');
    await pngDownload('', dest);
    const task = fakeTask(0.6);
    await generateVerifiedArt({ task, client: fakeLlm([{ title: '标题' }]), style: 'swiss', title: '标题', aspect: '4:3', dest, download: pngDownload });
    expect(task.inputs).toHaveLength(1);
    writeFileSync(join(dir, 'cover-art-4x3.json'), '{坏');
    const task2 = fakeTask(0.6);
    await generateVerifiedArt({ task: task2, client: fakeLlm([{ title: '标题' }]), style: 'swiss', title: '标题', aspect: '4:3', dest, download: pngDownload });
    expect(task2.inputs).toHaveLength(1);
  });
});

describe('coverTitle（兜底标题）', () => {
  const hook = (headline: string, kicker?: string): Storyboard['shots'][number] => ({ start: 0, end: 3, layout: 'split', card: { template: 'hook', props: { index: 1, total: 1, headline, highlight: [], ...(kicker ? { kicker } : {}) } } });

  it('取第一张 hook 的 headline（截断到 14 字），kicker 作小标题', () => {
    const sb: Storyboard = { shots: [{ start: 0, end: 1, layout: 'full' }, hook('为什么说前线部署工程师是今年最缺的人才岗位', '一个新岗位'), hook('第二张')] };
    expect(coverTitle(sb, [{ start: 0, end: 1, text: '字幕' }])).toEqual({ title: '为什么说前线部署工程师是今年', subtitle: '一个新岗位' });
  });

  it('没有 hook 时取第一句字幕；都没有时报错', () => {
    expect(coverTitle({ shots: [] }, [{ start: 0, end: 1, text: '大家好今天聊聊 FDE' }])).toEqual({ title: '大家好今天聊聊 FDE' });
    expect(() => coverTitle({ shots: [] }, [])).toThrow('封面标题');
  });
});

describe('pickPersonFrame', () => {
  it('候选帧在时长内均匀分布（取各段中点）', () => {
    expect(candidateTimes(6, 6)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5]);
  });

  it('把 6 帧拼图交给读图模型，返回所选帧的秒数；模型失败或编号无效时取 1/3 处', async () => {
    const video = await makeVideo(mkdtempSync(join(tmpdir(), 'mz-cover-p-')), 3);
    const llm = fakeLlm([{ index: 2 }]);
    expect(await pickPersonFrame(video, cfg, llm)).toBeCloseTo(0.75);
    expect(llm.calls[0].images).toHaveLength(1);
    expect(llm.calls[0].images?.[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(llm.calls[0].user).toContain('6');
    expect(await pickPersonFrame(video, cfg, fakeLlm([{ index: 9 }]))).toBeCloseTo(1);
    expect(await pickPersonFrame(video, cfg, fakeLlm([() => { throw new Error('超时'); }]))).toBeCloseTo(1);
  });
});

describe('cutoutPersonWithRetry', () => {
  it('第一帧没抠到人时，再试最多 2 个离它最近的候选帧', async () => {
    const video = await makeVideo(mkdtempSync(join(tmpdir(), 'mz-cover-r-')), 3);
    const tried: number[] = [];
    const never = async (_v: string, sec: number): Promise<boolean> => { tried.push(sec); return false; };
    expect(await cutoutPersonWithRetry(video, 0.75, '/tmp/p.png', cfg, {}, never)).toBe(false);
    expect(tried.map((t) => Number(t.toFixed(2)))).toEqual([0.75, 0.25, 1.25]);
    const secondTime: number[] = [];
    const second = async (_v: string, sec: number): Promise<boolean> => { secondTime.push(sec); return secondTime.length === 2; };
    expect(await cutoutPersonWithRetry(video, 0.75, '/tmp/p.png', cfg, {}, second)).toBe(true);
    expect(secondTime).toHaveLength(2);
  });
});

/** 合成 w×h 的 fgr（三个平面依次 0.2/0.4/0.6）与 pha（矩形内为 1） */
function synth(w: number, h: number, rect: { x0: number; x1: number; y0: number; y1: number }): { fgr: Float32Array; pha: Float32Array } {
  const fgr = Float32Array.from({ length: 3 * w * h }, (_, i) => [0.2, 0.4, 0.6][Math.floor(i / (w * h))]);
  const pha = Float32Array.from({ length: w * h }, (_, i) => {
    const x = i % w;
    const y = Math.floor(i / w);
    return x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1 ? 1 : 0;
  });
  return { fgr, pha };
}

describe('cutoutRgba（单帧抠像的裁切与渐隐）', () => {
  it('按 alpha 外接框加边距裁切，颜色取 fgr、透明度取 pha', () => {
    const { fgr, pha } = synth(100, 100, { x0: 30, x1: 60, y0: 20, y1: 80 });
    const cut = cutoutRgba(fgr, pha, 100, 100);
    expect(cut.found).toBe(true);
    expect([cut.width, cut.height]).toEqual([36, 66]);
    const center = ((cut.height >> 1) * cut.width + (cut.width >> 1)) * 4;
    expect([...cut.rgba.subarray(center, center + 4)]).toEqual([51, 102, 153, 255]);
    expect(cut.rgba[3]).toBe(0);
  });

  it('人物被原画面左侧截断时，左侧渐隐、右侧不变；关闭渐隐时保持硬边', () => {
    const { fgr, pha } = synth(100, 100, { x0: 0, x1: 60, y0: 20, y1: 100 });
    const alphaAt = (c: ReturnType<typeof cutoutRgba>, x: number): number => c.rgba[((c.height - 1) * c.width + x) * 4 + 3];
    const faded = cutoutRgba(fgr, pha, 100, 100);
    expect(alphaAt(faded, 0)).toBeLessThan(10);
    expect(alphaAt(faded, 30)).toBe(255);
    expect(alphaAt(faded, 59)).toBe(255);
    const hard = cutoutRgba(fgr, pha, 100, 100, { fadeCutSides: false });
    expect(alphaAt(hard, 0)).toBe(255);
  });

  it('没有人物时返回整帧并标注 found=false', () => {
    const { fgr, pha } = synth(40, 30, { x0: 0, x1: 0, y0: 0, y1: 0 });
    const cut = cutoutRgba(fgr, pha, 40, 30);
    expect([cut.found, cut.width, cut.height]).toEqual([false, 40, 30]);
  });
});

describe.skipIf(!hasRvm())('本地抠像与封面合成（需要 RVM 模型）', () => {
  it('cutoutPerson 输出带 alpha 的 PNG', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cover-c-'));
    const video = await makeVideo(dir, 1);
    const out = join(dir, 'person.png');
    const found = await cutoutPerson(video, 0.5, out, cfg);
    expect(typeof found).toBe('boolean');
    expect(await pixFmt(out)).toMatch(/a/);
  });

  it('makeCovers：第一次标题核对错、之后都对 → 共生成 3 次；输出 1080×1440 与 1440×1080', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-cover-m-'));
    const personVideo = await makeVideo(workDir, 2);
    let verifies = 0;
    const client: LlmClient = {
      async chatJson(opts) {
        if (opts.user.includes('编号')) return { index: 1 };
        verifies += 1;
        return { title: verifies === 1 ? '错字标题' : 'FDE 是什么岗位' };
      },
    };
    const res = await makeCovers({ workDir, style: 'neobrutal', title: 'FDE 是什么岗位', subtitle: 'AI 落地的关键角色', personVideo, cfg, task: fakeTask(0.6), client, download: pngDownload });
    expect(res.attempts).toBe(3);
    expect(res.costYuan).toBe(1.8);
    expect(res.unverified).toEqual([]);
    expect(res.cover34).toBe(join(workDir, 'cover-3x4.png'));
    expect(res.cover43).toBe(join(workDir, 'cover-4x3.png'));
    expect(await dims(res.cover34)).toEqual([1080, 1440]);
    expect(await dims(res.cover43)).toEqual([1440, 1080]);
    expect(res.reused).toEqual([]);

    // 再跑一次：两张底图都复用，不再调用生图
    const task2 = fakeTask(0.6);
    const again = await makeCovers({ workDir, style: 'neobrutal', title: 'FDE 是什么岗位', subtitle: 'AI 落地的关键角色', personVideo, cfg, task: task2, client, download: pngDownload });
    expect([again.attempts, again.costYuan, task2.inputs.length]).toEqual([0, 0, 0]);
    expect(again.reused).toEqual(['3:4', '4:3']);
  }, 300_000);
});
