import React from 'react';
import { useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { BADGE_PAD_X, Badge, CONTENT_W, CardFrame, Crumb, Reveal, SafeArea, clampLines, easeAt, fitFontSize, fitScale, lineCount, springAt, type PropsOf, type TemplateProps } from './parts.js';

type Row = PropsOf<'evidenceList'>['rows'][number];

const PAD_X = 44;
const INNER_W = CONTENT_W - PAD_X * 2;
const BADGE_W = 100;
const ROW_PAD_X = 18;
const TEXT_W = INNER_W - BADGE_W - 26 - ROW_PAD_X * 2;
const TEXT_PX = 34;
const TAG_COLORS = [THEME.badge['证据'], THEME.badge['收益'], THEME.badge['来源']];
const ROW_START = 0.12;
const TAG_GAP = 14;
/** 每个来源标签可用的文字宽度：最多 3 个并排，扣掉间距与左右内边距 */
const TAG_TEXT_W = (INNER_W - TAG_GAP * 2) / 3 - BADGE_PAD_X * 2 - 4;
const ROW_STAGGER = 0.07;

/** 一行：左侧彩色标签 + 右侧文字；高亮行在滑入后铺一层同色浅底（从左往右刷开） */
const EvidenceRow: React.FC<{ row: Row; hot: boolean; p: number; mark: number }> = ({ row, hot, p, mark }) => {
  const color = THEME.badge[row.badge];
  const px = fitFontSize(row.text, TEXT_W, TEXT_PX, 24, 2);
  return (
    <Reveal p={p} dx={-40} dy={0}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 26, padding: `13px ${ROW_PAD_X}px`, borderRadius: 18 }}>
        {hot ? <div style={{ position: 'absolute', inset: 0, borderRadius: 18, background: `${color}1F`, transform: `scaleX(${mark})`, transformOrigin: 'left center' }} /> : null}
        <div style={{ position: 'relative' }}><Badge text={row.badge} color={color} width={BADGE_W} height={50} size={25} /></div>
        <div style={{ position: 'relative', fontSize: px, fontWeight: hot ? 600 : 500, lineHeight: 1.35, ...clampLines(2) }}>{row.text}</div>
      </div>
    </Reveal>
  );
};

const Tags: React.FC<{ tags: string[]; local: number; delay: number; fps: number }> = ({ tags, local, delay, fps }) => (
  <div style={{ marginTop: 26, display: 'flex', gap: TAG_GAP }}>
    {tags.map((t, i) => (
      <Reveal key={i} p={springAt(local, delay + i * 0.08, fps, { damping: 13, mass: 0.6 })} dy={12} from={0.7}>
        <Badge text={t} color={TAG_COLORS[i % TAG_COLORS.length]} size={fitFontSize(t, TAG_TEXT_W, 25, 16)} height={50} />
      </Reveal>
    ))}
  </div>
);

/** 估算卡片高度，超出安全区时整体缩小 */
function estimateHeight(props: PropsOf<'evidenceList'>, titlePx: number): number {
  const titleLines = lineCount(props.title, INNER_W, titlePx);
  const rows = props.rows.reduce((h, r) => h + (lineCount(r.text, TEXT_W, fitFontSize(r.text, TEXT_W, TEXT_PX, 24, 2)) > 1 ? 116 : 78), 0);
  return 84 + (props.crumb ? 44 : 0) + titleLines * titlePx * 1.25 + 22 + rows + (props.rows.length - 1) * 6 + (props.tags?.length ? 76 : 0);
}

/** 证据列表卡：面包屑 + 标题 + 成本/收益/证据/来源 行 + 底部来源标签 */
export const EvidenceList: React.FC<TemplateProps<'evidenceList'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const titlePx = fitFontSize(props.title, INNER_W, 52, 34, 3);
  const hot = new Set(props.highlight ?? []);
  const rowsDone = ROW_START + props.rows.length * ROW_STAGGER;
  return (
    <SafeArea scale={fitScale(estimateHeight(props, titlePx))}>
      <CardFrame padding={`40px ${PAD_X}px 44px`}>
        <Reveal p={springAt(local, 0.05, fps)} dy={18}>
          {props.crumb ? <Crumb text={props.crumb} size={24} maxWidth={INNER_W} /> : null}
          <div style={{ marginTop: props.crumb ? 14 : 0, fontSize: titlePx, fontWeight: 800, lineHeight: 1.25, letterSpacing: '-0.01em', ...clampLines(3) }}>{props.title}</div>
        </Reveal>
        <div style={{ marginTop: 22, marginLeft: -ROW_PAD_X, marginRight: -ROW_PAD_X, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {props.rows.map((r, i) => (
            <EvidenceRow key={i} row={r} hot={hot.has(i)} p={springAt(local, ROW_START + i * ROW_STAGGER, fps)} mark={easeAt(local, ROW_START + i * ROW_STAGGER + 0.2, 0.35)} />
          ))}
        </div>
        {props.tags?.length ? <Tags tags={props.tags} local={local} delay={rowsDone + 0.05} fps={fps} /> : null}
      </CardFrame>
    </SafeArea>
  );
};
