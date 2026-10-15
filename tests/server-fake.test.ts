import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { CostMeter } from '../src/cost/meter.js';
import { buildEditContext, formatContext } from '../src/edit/context.js';
import { validateOps } from '../src/edit/validate.js';
import { formatTokensForLlm } from '../src/cut/llm-cuts.js';
import { fakeAppOptions, fakeDeps, fakeLlm, isFakeMode } from '../src/server/fake.js';
import { makeState } from './helpers/edit-state.js';

const ask = (label: string, user: string) => fakeLlm().chatJson({ model: 'm', system: '', user, label });

describe('假模型模式（MINGZHI_FAKE_LLM=1）', () => {
  it('只认环境变量等于 1', () => {
    expect(isFakeMode({ MINGZHI_FAKE_LLM: '1' })).toBe(true);
    expect(isFakeMode({ MINGZHI_FAKE_LLM: 'true' })).toBe(false);
    expect(isFakeMode({})).toBe(false);
  });

  it('剪口误：剪掉语气词、口头禅、改口与紧挨着的重复', async () => {
    const tokens = [...'然后呢嗯我去逛去逛一个项目不对是两个'].map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.2 }));
    const out = (await ask('剪口误', formatTokensForLlm(tokens))) as { cuts: { from: number; to: number; type: string }[] };
    expect(out.cuts.map((c) => [c.from, c.to, c.type])).toEqual([[0, 2, 'filler'], [3, 3, 'filler'], [5, 6, 'repeat'], [13, 14, 'slip']]);
  });

  it('分镜：按总时长铺满，分屏卡与全屏交替', async () => {
    const out = (await ask('分镜', '总时长：18.00 秒\n可用素材：无\n字幕：…')) as { shots: { start: number; end: number; layout: string }[] };
    expect(out.shots[0].start).toBe(0);
    expect(out.shots.at(-1)?.end).toBeCloseTo(18, 1);
    expect(out.shots.map((s) => s.layout).slice(0, 3)).toEqual(['split', 'full', 'split']);
  });

  it('修改：改被引用的分屏卡，给两个选项，选项里的操作能通过校验', async () => {
    const state = makeState();
    const split = state.storyboard.shots.findIndex((s) => s.layout === 'split');
    const at = state.storyboard.shots[split].start + 0.01;
    const message = `@00:0${Math.floor(at)} 这张换掉`;
    const plan = (await ask('修改', `${formatContext(buildEditContext(state, message, []))}\n\n用户的话：${message}`)) as { ops: unknown[]; options: { ops: unknown[] }[] };
    expect(plan.ops).toEqual([]);
    expect(plan.options).toHaveLength(2);
    for (const o of plan.options) expect(validateOps(o.ops, state, []).dropped).toEqual([]);
  });

  it('注入：key 校验恒过、价格表为空、运行器拿到假模型与假生图，按名义单价记账', async () => {
    const deps = fakeDeps(loadConfig({}));
    expect(await deps.validateKey?.('随便')).toBe(true);
    expect(await deps.loadPrices?.('随便')).toEqual({});
    const meter = new CostMeter({}, 10);
    const clients = deps.ctxOverrides?.clients?.(meter);
    expect(clients?.task).toBeDefined();
    const shot = await clients?.task?.run({ modelName: 'x', modelType: 'text2img' }, { kind: 'image', label: '背景生图' });
    expect(shot?.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(meter.total).toBeGreaterThan(0);
  });

  it('假模式必须用独立数据目录；key 只存在该目录下的文件里，不碰系统钥匙串', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-fake-'));
    const cfg = { ...loadConfig({}), dataDir: dir };
    expect(() => fakeAppOptions(cfg, {})).toThrow('MINGZHI_DATA_DIR');
    expect(() => fakeAppOptions(cfg, { MINGZHI_DATA_DIR: join(homedir(), '.mingzhi') })).toThrow('不能是 ~/.mingzhi');
    const opts = fakeAppOptions(cfg, { MINGZHI_DATA_DIR: dir });
    await opts.keyStore?.set('sk-fake-key-123');
    expect(readFileSync(join(dir, 'key'), 'utf8').trim()).toBe('sk-fake-key-123');
    expect(await opts.keyStore?.get()).toBe('sk-fake-key-123');
    await opts.keyStore?.clear();
    expect(existsSync(join(dir, 'key'))).toBe(false);
  });
});
