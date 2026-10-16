import React from 'react';
import { useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { BADGE_PAD_X, Badge, CONTENT_W, CardFrame, Crumb, Reveal, SafeArea, clampLines, easeAt, fitFontSize, fitScale, itemTimes, lineCount, litIndex, springAt, type PropsOf, type TemplateProps } from './parts.js';

type Row = PropsOf<'evidenceList'>['rows'][number];

const PAD_X = 48;
const INNER_W = CONTENT_W - PAD_X * 2;
const BADGE_W = 112;
const ROW_PAD_X = 20;
const TEXT_W = INNER_W - BADGE_W - 28 - ROW_PAD_X * 2;
/** 行数少（≤ 2）时字更大、行距更松，卡片不显空 */
const textPxFor = (rows: number): number => (rows <= 2 ? 48 : 42);
const TEXT_MIN_PX = 28;
const TEXT_LINE_H = 1.32;
const BADGE_H = 56;
const TITLE_PX = 60;
/** 行的上下内边距：行数少（≤ ROOMY_ROWS）时放宽，填满卡片 */
const ROOMY_ROWS = 3;
const rowPadY = (rows: number): number => (rows <= 2 ? 34 : rows <= ROOMY_ROWS ? 26 : 14);
const ROW_GAP = 8;
/** 估算行数时按 94% 行宽算：断不开的长串（如全大写英文）按字符折行会多损耗，宁可多估一行 */
const EST_WIDTH = 0.94;
const TAG_COLORS = [THEME.badge['证据'], THEME.badge['收益'], THEME.badge['来源']];
const ROW_START = 0.12;
const TAG_GAP = 14;
/** 每个来源标签可用的文字宽度：最多 3 个并排，扣掉间距与左右内边距 */
const TAG_TEXT_W = (INNER_W - TAG_GAP * 2) / 3 - BADGE_PAD_X * 2 - 4;
const ROW_STAGGER = 0.07;
/** 还没出现的行：虚线占位（持续演进时提示后面还有内容，版面也不跳） */
const PENDING = '2.5px dashed #E2DDD4';

const evidenceTitlePx = (title: string): number => fitFontSize(title, INNER_W, TITLE_PX, 38, 3);
const rowPx = (text: string, rows: number): number => fitFontSize(text, TEXT_W, textPxFor(rows), TEXT_MIN_PX, 2);

/** 一行：左侧彩色标签 + 右侧文字；点亮的行铺一层同色浅底（从左往右刷开）；pending 时先画虚线占位 */
const EvidenceRow: React.FC<{ row: Row; hot: boolean; p: number; mark: number; padY: number; pending: boolean; rows: number }> = ({ row, hot, p, mark, padY, pending, rows }) => {
  const color = THEME.badge[row.badge];
  return (
    <div style={{ position: 'relative' }}>
      {pending ? <div style={{ position: 'absolute', inset: 0, borderRadius: 20, border: PENDING, opacity: Math.max(0, 1 - p * 1.5) }} /> : null}
      <Reveal p={p} dx={-40} dy={0}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 28, padding: `${padY}px ${ROW_PAD_X}px`, borderRadius: 20 }}>
          {hot ? <div style={{ position: 'absolute', inset: 0, borderRadius: 20, background: `${color}1F`, transform: `scaleX(${mark})`, transformOrigin: 'left center' }} /> : null}
          <div style={{ position: 'relative' }}><Badge text={row.badge} color={color} width={BADGE_W} height={BADGE_H} size={28} /></div>
          <div style={{ position: 'relative', minWidth: 0, fontSize: rowPx(row.text, rows), fontWeight: hot ? 700 : 500, lineHeight: TEXT_LINE_H, overflowWrap: 'anywhere', ...clampLines(2) }}>{row.text}</div>
        </div>
      </Reveal>
    </div>
  );
};

const Tags: React.FC<{ tags: string[]; local: number; delay: number; fps: number }> = ({ tags, local, delay, fps }) => (
  <div style={{ marginTop: 28, display: 'flex', gap: TAG_GAP }}>
    {tags.map((t, i) => (
      <Reveal key={i} p={springAt(local, delay + i * 0.08, fps, { damping: 13, mass: 0.6 })} dy={12} from={0.7}>
        <Badge text={t} color={TAG_COLORS[i % TAG_COLORS.length]} size={fitFontSize(t, TAG_TEXT_W, 26, 16)} height={52} />
      </Reveal>
    ))}
  </div>
);

/** 一行的高度：标签与文字取高者，加上下内边距 */
function rowHeight(text: string, padY: number, rows: number): number {
  const px = rowPx(text, rows);
  const lines = Math.min(2, lineCount(text, TEXT_W * EST_WIDTH, px));
  return Math.max(BADGE_H, lines * px * TEXT_LINE_H) + padY * 2;
}

/** 估算卡片高度（含卡片上下内边距 88），超出安全区时整体缩小；空白率估算也用它 */
export function estimateEvidenceHeight(props: PropsOf<'evidenceList'>, titlePx = evidenceTitlePx(props.title)): number {
  const titleLines = Math.min(3, lineCount(props.title, INNER_W * EST_WIDTH, titlePx));
  const padY = rowPadY(props.rows.length);
  const rows = props.rows.reduce((h, r) => h + rowHeight(r.text, padY, props.rows.length), 0);
  return 88 + (props.crumb ? 50 : 0) + titleLines * titlePx * 1.22 + 26 + rows + (props.rows.length - 1) * ROW_GAP + (props.tags?.length ? 80 : 0);
}

/** 哪些行点亮：持续演进时是最新出现的那一行（随口播往下走），否则按 highlight */
function hotRows(props: PropsOf<'evidenceList'>, times: number[], local: number): Set<number> {
  if (props.reveal && props.reveal.length === props.rows.length) return new Set([litIndex(times, local)]);
  return new Set(props.highlight ?? []);
}

/** 证据列表卡：面包屑 + 标题 + 成本/收益/证据/来源/要点 行 + 底部来源标签；有 reveal 时随口播逐行出现并点亮当前行 */
export const EvidenceList: React.FC<TemplateProps<'evidenceList'>> = ({ props, local, dur }) => {
  const { fps } = useVideoConfig();
  const titlePx = evidenceTitlePx(props.title);
  const times = itemTimes(props.reveal, props.rows.length, (i) => ROW_START + i * ROW_STAGGER, dur);
  const hot = hotRows(props, times, local);
  const evolving = props.reveal?.length === props.rows.length;
  const rowsDone = Math.max(...times) + 0.12;
  return (
    <SafeArea scale={fitScale(estimateEvidenceHeight(props, titlePx))}>
      <CardFrame fill padding={`44px ${PAD_X}px 48px`}>
        <Reveal p={springAt(local, 0.05, fps)} dy={18}>
          {props.crumb ? <Crumb text={props.crumb} size={28} maxWidth={INNER_W} /> : null}
          <div style={{ marginTop: props.crumb ? 16 : 0, fontSize: titlePx, fontWeight: 800, lineHeight: 1.22, letterSpacing: '-0.01em', overflowWrap: 'anywhere', ...clampLines(3) }}>{props.title}</div>
        </Reveal>
        <div style={{ marginTop: 26, marginLeft: -ROW_PAD_X, marginRight: -ROW_PAD_X, display: 'flex', flexDirection: 'column', gap: ROW_GAP }}>
          {props.rows.map((r, i) => (
            <EvidenceRow key={i} rows={props.rows.length} row={r} hot={hot.has(i)} pending={evolving} padY={rowPadY(props.rows.length)} p={springAt(local, times[i], fps)} mark={easeAt(local, times[i] + 0.2, 0.35)} />
          ))}
        </div>
        {props.tags?.length ? <Tags tags={props.tags} local={local} delay={rowsDone} fps={fps} /> : null}
      </CardFrame>
    </SafeArea>
  );
};
