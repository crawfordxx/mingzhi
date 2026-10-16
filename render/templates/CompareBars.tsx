import React from 'react';
import { useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { readableOn } from '../../src/qa/contrast.js';
import { CONTENT_W, CardFrame, Crumb, Reveal, SafeArea, SurfaceContext, easeAt, fitFontSize, fitScale, itemTimes, litIndex, springAt, textEm, type PropsOf, type TemplateProps } from './parts.js';

type Tone = 'bad' | 'warn' | 'good';
type Item = PropsOf<'compareBars'>['items'][number];

const PAD_X = 40;
const BOTTLE_W = 78;
/** 纸面上整组放进一张撑满卡片区的白卡（左右内边距 PANEL_PAD），条目卡变成卡内浅色块 */
const PANEL_PAD = 36;
const INSET_BG = '#F6F3EE';
const COL_W = CONTENT_W - PANEL_PAD * 2 - PAD_X * 2 - BOTTLE_W - 34;
const GREEN = THEME.green;
/** 文字/进度条用色 与 小瓶用色 */
const TONE: Record<Tone, { ink: string; fill: string; bottle: string }> = {
  bad: { ink: THEME.redText, fill: THEME.red, bottle: THEME.red },
  warn: { ink: THEME.goldText, fill: THEME.gold, bottle: THEME.neutral },
  good: { ink: THEME.greenText, fill: GREEN, bottle: GREEN },
};
/** 单行文字：字宽估算失准时以省略号收尾，不溢出卡片 */
const ONE_LINE: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' };
const ITEM_H = 200;
/** 纸面上条目卡拉高撑满卡片区，单张不超过这么高 */
const ITEM_MAX_H = 290;
const ITEM_GAP = 30;
/** 柱条生长时长（秒） */
const GROW_SEC = 0.8;

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
  <div style={{ marginTop: 22, height: 28, borderRadius: 14, background: '#EFEDE9', overflow: 'hidden' }}>
    <div style={{ width: `${value * p * 100}%`, height: '100%', borderRadius: 14, background: color }} />
  </div>
);

/** 一项：小瓶 + 名称 + 注释 + 进度条；lit 为持续演进时正在讲的那一项（其余略淡） */
const ItemCard: React.FC<{ item: Item; grow: number; dim: boolean; inset: boolean }> = ({ item, grow, dim, inset }) => {
  const tone = TONE[item.tone];
  const namePx = fitFontSize(item.name, COL_W * 0.52, 46, 28);
  const notePx = item.note ? fitFontSize(item.note, COL_W, 31, 22) : 31;
  return (
    <CardFrame padding={`30px ${PAD_X}px`} style={{ display: 'flex', alignItems: 'center', gap: 34, opacity: dim ? 0.55 : 1, ...(inset ? { height: '100%', boxSizing: 'border-box', background: INSET_BG, boxShadow: 'none' } : {}) }}>
      <Bottle tone={item.tone} label={bottleLabel(item.name)} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 20, whiteSpace: 'nowrap' }}>
          <span style={{ ...ONE_LINE, fontSize: namePx, fontWeight: 800 }}>{item.name}</span>
          {item.annotation ? <span style={{ ...ONE_LINE, flex: 'none', maxWidth: '48%', fontSize: fitFontSize(item.annotation, COL_W * 0.44, 38, 24), fontWeight: 800, color: tone.ink }}>{item.annotation}</span> : null}
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

/** 对比条卡：每项一张卡（小瓶 + 名称 + 注释 + 进度条），可选结论按钮；纸面上整组放进撑满卡片区的白卡，条目拉高均分。
 * 有 reveal 时各项卡片先全部就位，柱条随口播逐条长出，正在讲的那项亮、其余略淡，最后出结论 */
export const CompareBars: React.FC<TemplateProps<'compareBars'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const paper = React.useContext(SurfaceContext) === 'paper';
  const n = props.items.length;
  const est = (props.crumb ? 76 : 0) + n * ITEM_H + (n - 1) * ITEM_GAP + (props.verdict ? 128 : 0) + (paper ? 80 : 0);
  const times = itemTimes(props.reveal, n, (i) => 0.2 + i * 0.25);
  const evolving = props.reveal?.length === n;
  const lit = evolving ? litIndex(times, local) : -1;
  const body = (
    <>
      {props.crumb ? <Reveal p={springAt(local, 0, fps)} dy={12} style={{ marginBottom: 28 }}><Crumb text={props.crumb} size={30} /></Reveal> : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: ITEM_GAP, ...(paper ? { flex: 1, minHeight: 0, justifyContent: 'center' } : {}) }}>
        {props.items.map((it, i) => (
          <Reveal key={i} p={springAt(local, 0.05 + i * 0.12, fps)} dy={30} style={paper ? { flex: 1, minHeight: 0, maxHeight: ITEM_MAX_H } : undefined}>
            <ItemCard item={it} grow={easeAt(local, times[i], GROW_SEC)} dim={evolving && i !== lit && lit < n - 1} inset={paper} />
          </Reveal>
        ))}
      </div>
      {props.verdict ? <Verdict text={props.verdict} p={springAt(local, Math.max(...times) + GROW_SEC * 0.6, fps)} /> : null}
    </>
  );
  return <SafeArea scale={fitScale(est)}>{paper ? <CardFrame fill padding={`40px ${PANEL_PAD}px`}>{body}</CardFrame> : body}</SafeArea>;
};
