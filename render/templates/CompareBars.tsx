import React from 'react';
import { useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { readableOn } from '../../src/qa/contrast.js';
import { CONTENT_W, CardFrame, Crumb, Reveal, SafeArea, easeAt, fitFontSize, fitScale, springAt, textEm, type PropsOf, type TemplateProps } from './parts.js';

type Tone = 'bad' | 'warn' | 'good';
type Item = PropsOf<'compareBars'>['items'][number];

const PAD_X = 40;
const BOTTLE_W = 78;
const COL_W = CONTENT_W - PAD_X * 2 - BOTTLE_W - 34;
const GREEN = THEME.green;
/** 文字/进度条用色 与 小瓶用色 */
const TONE: Record<Tone, { ink: string; fill: string; bottle: string }> = {
  bad: { ink: THEME.redText, fill: THEME.red, bottle: THEME.red },
  warn: { ink: THEME.goldText, fill: THEME.gold, bottle: THEME.neutral },
  good: { ink: THEME.greenText, fill: GREEN, bottle: GREEN },
};
/** 单行文字：字宽估算失准时以省略号收尾，不溢出卡片 */
const ONE_LINE: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' };
const ITEM_H = 210;
const ITEM_GAP = 40;

/** 名称括号里的词作为瓶身标签，例如「甜饮料（含糖）」→「含糖」 */
export function bottleLabel(name: string): string | null {
  const m = name.match(/[（(]([^）)]{1,3})[）)]/);
  return m ? m[1] : null;
}

const Bottle: React.FC<{ tone: Tone; label: string | null }> = ({ tone, label }) => {
  const color = TONE[tone].bottle;
  return (
    <div style={{ width: BOTTLE_W, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: 46, height: 14, borderRadius: '6px 6px 2px 2px', background: '#CDD1D5' }} />
      <div style={{ position: 'relative', width: BOTTLE_W, height: 118, marginTop: 3, borderRadius: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: color, boxShadow: 'inset -10px 0 0 rgba(0, 0, 0, 0.07)' }}>
        <div style={{ position: 'absolute', left: 11, top: 14, bottom: 14, width: 7, borderRadius: 4, background: 'rgba(255, 255, 255, 0.28)' }} />
        {label ? <span style={{ position: 'relative', color: readableOn(color), fontSize: Math.min(24, Math.floor(60 / textEm(label))), fontWeight: 800, letterSpacing: '0.04em' }}>{label}</span> : null}
      </div>
    </div>
  );
};

const Bar: React.FC<{ value: number; color: string; p: number }> = ({ value, color, p }) => (
  <div style={{ marginTop: 20, height: 24, borderRadius: 12, background: '#EFEDE9', overflow: 'hidden' }}>
    <div style={{ width: `${value * p * 100}%`, height: '100%', borderRadius: 12, background: color }} />
  </div>
);

const ItemCard: React.FC<{ item: Item; grow: number }> = ({ item, grow }) => {
  const tone = TONE[item.tone];
  const namePx = fitFontSize(item.name, COL_W * 0.52, 40, 26);
  const notePx = item.note ? fitFontSize(item.note, COL_W, 28, 20) : 28;
  return (
    <CardFrame padding={`30px ${PAD_X}px`} style={{ display: 'flex', alignItems: 'center', gap: 34 }}>
      <Bottle tone={item.tone} label={bottleLabel(item.name)} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 20, whiteSpace: 'nowrap' }}>
          <span style={{ ...ONE_LINE, fontSize: namePx, fontWeight: 800 }}>{item.name}</span>
          {item.annotation ? <span style={{ ...ONE_LINE, flex: 'none', maxWidth: '48%', fontSize: fitFontSize(item.annotation, COL_W * 0.44, 34, 22), fontWeight: 800, color: tone.ink }}>{item.annotation}</span> : null}
        </div>
        {item.note ? <div style={{ ...ONE_LINE, marginTop: 6, fontSize: notePx, fontWeight: 500, color: THEME.sub, whiteSpace: 'nowrap' }}>{item.note}</div> : null}
        <Bar value={item.value} color={tone.fill} p={grow} />
      </div>
    </CardFrame>
  );
};

const Verdict: React.FC<{ text: string; p: number }> = ({ text, p }) => (
  <Reveal p={p} dy={18} from={0.85} style={{ marginTop: 40, display: 'flex', justifyContent: 'center' }}>
    <div style={{ height: 88, padding: '0 52px', borderRadius: 44, background: THEME.ink, color: '#FFFFFF', display: 'flex', alignItems: 'center',
      fontSize: fitFontSize(text, CONTENT_W - 140, 34, 24), fontWeight: 700, letterSpacing: '0.02em', boxShadow: '0 16px 34px rgba(28, 27, 25, 0.28)', whiteSpace: 'nowrap' }}>
      {text}
    </div>
  </Reveal>
);

/** 对比条卡：每项一张白卡（小瓶 + 名称 + 注释 + 进度条），可选结论按钮 */
export const CompareBars: React.FC<TemplateProps<'compareBars'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const n = props.items.length;
  const est = (props.crumb ? 72 : 0) + n * ITEM_H + (n - 1) * ITEM_GAP + (props.verdict ? 128 : 0);
  const barDelay = (i: number): number => 0.2 + i * 0.25;
  return (
    <SafeArea scale={fitScale(est)}>
      {props.crumb ? <Reveal p={springAt(local, 0, fps)} dy={12} style={{ marginBottom: 36 }}><Crumb text={props.crumb} /></Reveal> : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: ITEM_GAP }}>
        {props.items.map((it, i) => (
          <Reveal key={i} p={springAt(local, 0.05 + i * 0.12, fps)} dy={30}>
            <ItemCard item={it} grow={easeAt(local, barDelay(i), 0.8)} />
          </Reveal>
        ))}
      </div>
      {props.verdict ? <Verdict text={props.verdict} p={springAt(local, barDelay(n) + 0.3, fps)} /> : null}
    </SafeArea>
  );
};
