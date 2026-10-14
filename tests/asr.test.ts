import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTokens } from '../src/asr/tokens.js';
import { transcribeWav } from '../src/asr/local-asr.js';
import { extractWav16k } from '../src/media/extract-audio.js';
import { loadConfig } from '../src/config.js';
import { hasModels } from './helpers/models.js';

describe('buildTokens', () => {
  it('加上片段偏移，end 取下一个 token 的开始，最长 0.5 秒', () => {
    const tokens = buildTokens({ tokens: ['今', '天', ' ', '好'], timestamps: [0.1, 0.3, 0.4, 1.5] }, 10, 12);
    expect(tokens).toEqual([
      { text: '今', start: 10.1, end: 10.3 },
      { text: '天', start: 10.3, end: 10.4 },
      { text: '好', start: 11.5, end: 12 },
    ]);
  });

  it('不修改入参', () => {
    const raw = { tokens: ['a'], timestamps: [0] };
    buildTokens(raw, 0, 1);
    expect(raw).toEqual({ tokens: ['a'], timestamps: [0] });
  });
});

describe.skipIf(!hasModels())('transcribeWav（需要本地模型）', () => {
  it('识别样片并在 1.5 秒停顿处切段', async () => {
    const cfg = loadConfig({});
    const wav = join(mkdtempSync(join(tmpdir(), 'mz-')), 'a.wav');
    await extractWav16k(join(import.meta.dirname, 'fixtures', 'talk.mp4'), wav, cfg);
    const t = transcribeWav(wav, cfg.modelsDir);
    const text = t.tokens.map((x) => x.text).join('');
    expect(text).toContain('高性价比');
    expect(t.segments.length).toBeGreaterThanOrEqual(2);
    const maxGap = Math.max(...t.segments.slice(1).map((s, i) => s.start - t.segments[i].end));
    expect(maxGap).toBeGreaterThan(1.0);
    expect(t.tokens.every((x, i) => i === 0 || x.start >= t.tokens[i - 1].start)).toBe(true);
  });
});
