import type { TimedCaption } from './lines.js';

/** P1 默认样式「刀锋」：白字黑描边，位于画面下方约 22% 处；P3 再扩展为 6–8 套预设 */
const FONT = 'PingFang SC';

function assTime(sec: number): string {
  const cs = Math.round(sec * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

const escapeText = (t: string): string => t.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N');

export function toAss(captions: TimedCaption[], video: { width: number; height: number }): string {
  const fontSize = Math.round(video.height * 0.034);
  const outline = Math.max(2, Math.round(fontSize * 0.09));
  const marginV = Math.round(video.height * 0.22);
  const header = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${video.width}`, `PlayResY: ${video.height}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${FONT},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,40,40,${marginV},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = captions.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${escapeText(c.text)}`);
  return [...header, ...events, ''].join('\n');
}
