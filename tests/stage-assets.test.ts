import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { trackPath, type Track } from '../src/assets/catalog.js';
import { stageAudio } from '../src/compose/stage-assets.js';

const track: Track = { id: 't1', title: 't', zip: 'z', entry: 'e.mp3', mood: 'chill', energy: 1, durationSec: 60 };

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mz-stage-data-'));
  const cfg = { ...loadConfig({}), dataDir };
  mkdirSync(join(dataDir, 'assets', 'music'), { recursive: true });
  writeFileSync(trackPath(cfg, track), 'MP3DATA');
  return { cfg, workDir: mkdtempSync(join(tmpdir(), 'mz-stage-work-')) };
}

describe('stageAudio', () => {
  it('复制曲目与实际用到的音效（去重），返回相对工作目录的路径', async () => {
    const { cfg, workDir } = setup();
    const cues = [{ sec: 0, sfx: 'enter' as const, volume: 0.3 }, { sec: 1, sfx: 'click' as const, volume: 0.3 }, { sec: 2, sfx: 'enter' as const, volume: 0.3 }];
    const out = await stageAudio(workDir, cfg, track, cues);
    expect(out.bgm).toBe('audio/bgm.mp3');
    expect(readFileSync(join(workDir, 'audio', 'bgm.mp3'), 'utf8')).toBe('MP3DATA');
    expect(out.sfxFiles).toEqual(['audio/sfx/enter.wav', 'audio/sfx/click.wav']);
    for (const f of out.sfxFiles) expect(existsSync(join(workDir, f))).toBe(true);
    expect(existsSync(join(workDir, 'audio', 'sfx', 'toggle.wav'))).toBe(false);
  });

  it('没有曲目或没有音效时不复制对应部分，且可重复调用', async () => {
    const { cfg, workDir } = setup();
    const none = await stageAudio(workDir, cfg, null, []);
    expect(none).toEqual({ sfxFiles: [] });
    const cues = [{ sec: 0, sfx: 'tick' as const, volume: 0.15 }];
    const a = await stageAudio(workDir, cfg, track, cues);
    const b = await stageAudio(workDir, cfg, track, cues);
    expect(b).toEqual(a);
  });

  it('曲目文件缺失时抛出明确错误', async () => {
    const { cfg, workDir } = setup();
    await expect(stageAudio(workDir, cfg, { ...track, id: 'missing' }, [])).rejects.toThrow(/missing/);
  });
});
