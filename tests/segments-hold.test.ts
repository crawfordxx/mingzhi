import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frameClock } from '../src/compose/frame-clock.js';
import { createStamper, segmentBounds, segmentSalt, shotHash, type HashLayer } from '../src/compose/segments.js';
import type { Shot, TalkProps } from '../src/storyboard/schema.js';

// CTA 放在内容句之后、起点等于口播内容结尾：CTA、留白、片尾这一段里人像与全屏素材定格在内容末帧，画的是前一镜（第 3 镜）
const captions = [{ start: 0.2, end: 4, text: '第一句内容' }, { start: 4.2, end: 9.88, text: '最后一句内容很重要' }];
const shotsWith = (prev: Partial<Shot>, first: Partial<Shot> = {}): Shot[] => [
  { start: 0, end: 6, layout: 'split', card: { template: 'title', props: { title: '标题' } }, ...first } as Shot,
  { start: 6, end: 8, layout: 'full' },
  { start: 8, end: 10, layout: 'broll', broll: { file: 'broll/a.jpg', kind: 'photo', focal: { x: 0.5, y: 0.5 } }, ...prev } as Shot,
  { start: 10, end: 12, layout: 'full', card: { template: 'cta', props: { actions: ['关注'], placed: true } } },
];
const base = { person: 'p.mp4', personWidth: 1080, personHeight: 1920, subject: null, captions, durationSec: 13.5, contentSec: 10 } as unknown as Omit<TalkProps, 'shots'>;

async function segHash(shots: Shot[], i: number, workDir = '/nonexistent', layer: HashLayer = 'render'): Promise<string> {
  const props = { ...base, shots } as TalkProps;
  const range = segmentBounds(shots, props.durationSec)[i];
  const salt = await segmentSalt(createStamper(workDir, 'code'), props, i, range, layer);
  return shotHash(shots[i], base, i, { shots, range, salt, layer });
}

describe('frameClock：与 Talk 同一规则', () => {
  const props = { shots: shotsWith({}), durationSec: 13.5, contentSec: 10 };
  it('内容结尾之前各层都用当前时刻', () => {
    expect(frameClock(props, 150)).toMatchObject({ sec: 5, visualSec: 5, personSec: 5, personHeld: false, shotHeld: false });
  });
  it('内容结尾之后人像定格在内容末帧，卡片继续；镜头结尾之后卡片也定格', () => {
    expect(frameClock(props, 330)).toMatchObject({ visualSec: 11, personSec: 299 / 30, personHeld: true, shotHeld: false });
    expect(frameClock(props, 380)).toMatchObject({ visualSec: 359 / 30, personSec: 299 / 30, shotHeld: true });
  });
});

describe('定格尾段的分段哈希：按实际画到的镜头算', () => {
  it('换 CTA 前一镜的 B-roll 文件：CTA 尾段的渲染哈希与内容哈希都变', async () => {
    const a = shotsWith({});
    const b = shotsWith({ broll: { file: 'broll/b.jpg', kind: 'photo', focal: { x: 0.5, y: 0.5 } } });
    expect(await segHash(b, 3)).not.toBe(await segHash(a, 3));
    expect(await segHash(b, 3, undefined, 'content')).not.toBe(await segHash(a, 3, undefined, 'content'));
  });
  it('前一镜换版式（全屏素材 → 画中画）或焦点：CTA 尾段哈希变', async () => {
    const a = shotsWith({});
    expect(await segHash(shotsWith({ layout: 'pip' }), 3)).not.toBe(await segHash(a, 3));
    expect(await segHash(shotsWith({ broll: { file: 'broll/a.jpg', kind: 'photo', focal: { x: 0.2, y: 0.5 } } }), 3)).not.toBe(await segHash(a, 3));
  });
  it('同名素材文件被覆盖：尾段盐值跟着变（素材指纹按定格镜头取）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-hold-'));
    mkdirSync(join(dir, 'broll'));
    writeFileSync(join(dir, 'broll', 'a.jpg'), 'one');
    const before = await segHash(shotsWith({}), 3, dir);
    writeFileSync(join(dir, 'broll', 'a.jpg'), 'two');
    expect(await segHash(shotsWith({}), 3, dir)).not.toBe(before);
  });
  it('尾段没画到的镜头（第 1 镜）改动不影响尾段哈希', async () => {
    const changed = shotsWith({}, { card: { template: 'title', props: { title: '别的标题' } } });
    expect(await segHash(changed, 3)).toBe(await segHash(shotsWith({}), 3));
  });
});
