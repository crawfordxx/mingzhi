import { describe, expect, it, vi } from 'vitest';
import { confirmRun } from '../src/cost/confirm.js';
import { estimateCost } from '../src/cost/estimate.js';

const estimate = estimateCost({ durationSec: 60, bgPrompt: false, broll: true, maxVideos: 1, qa: false });
const run = (over: Partial<Parameters<typeof confirmRun>[0]>) => {
  const printed: string[] = [];
  const ask = vi.fn(async () => 'y');
  return { printed, ask, result: confirmRun({ estimate, budgetYuan: 10, yes: false, isTTY: true, ask, print: (t) => printed.push(t), ...over }) };
};

describe('confirmRun', () => {
  it('始终先打印预估', async () => {
    const r = run({ ask: async () => 'n' });
    await r.result;
    expect(r.printed.join('\n')).toContain('预估花费');
  });

  it('交互终端：回答 y / Y / yes 继续', async () => {
    for (const answer of ['y', ' Y ', 'yes', 'YES']) expect(await run({ ask: async () => answer }).result).toBe(true);
  });

  it('交互终端：回车、n、其它回答都不继续', async () => {
    for (const answer of ['', 'n', 'no', 'maybe', '好']) expect(await run({ ask: async () => answer }).result).toBe(false);
  });

  it('提问文案为「继续吗？(y/N)」', async () => {
    const asked: string[] = [];
    await run({ ask: async (q) => { asked.push(q); return 'y'; } }).result;
    expect(asked[0]).toContain('继续吗？(y/N)');
  });

  it('--yes：不提问直接继续', async () => {
    const r = run({ yes: true });
    expect(await r.result).toBe(true);
    expect(r.ask).not.toHaveBeenCalled();
  });

  it('非交互终端：不提问直接继续（仍打印预估）', async () => {
    const r = run({ isTTY: false });
    expect(await r.result).toBe(true);
    expect(r.ask).not.toHaveBeenCalled();
    expect(r.printed).toHaveLength(1);
  });

  it('最高值超过预算时打印降级提示，仍可继续', async () => {
    const r = run({ budgetYuan: 1, ask: async () => 'y' });
    expect(await r.result).toBe(true);
    expect(r.printed.join('\n')).toContain('将自动降级');
  });
});
