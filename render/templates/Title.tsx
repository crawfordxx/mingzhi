import React from 'react';
import { useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { balanceLines, tokenize } from './headline.js';
import { CONTENT_W, CardFrame, Crumb, Reveal, SafeArea, SurfaceContext, clampLines, fitFontSize, maxFontSize, springAt, type TemplateProps } from './parts.js';

const PAD_X = 72;
const INNER_W = CONTENT_W - PAD_X * 2;
const TITLE_MAX_PX = 108;
const TITLE_MIN_PX = 52;
/** 断行时每行按 94% 行宽排，弥补字宽估算误差 */
const LINE_MARGIN = 0.94;

/** 浮层（压在人物胸前）里标题紧凑一些：最大 80px，最多 2 行 */
const COMPACT = { max: 80, lines: 2 } as const;

/** 标题字号：最多 3 行（浮层 2 行）能放下的最大字号（宁可折成两行也要大），夹在 52–108px（浮层上限 80px） */
export const titlePx = (title: string, compact = false): number =>
  Math.max(TITLE_MIN_PX, Math.min(compact ? COMPACT.max : TITLE_MAX_PX, maxFontSize(title, INNER_W * LINE_MARGIN, compact ? COMPACT.lines : 3)));
/** 均衡断行后的标题各行文字 */
export const titleLines = (title: string, compact = false): string[] =>
  balanceLines(tokenize(title, []), (INNER_W * LINE_MARGIN) / titlePx(title, compact)).map((l) => l.map((t) => t.text).join(''));

/** 标题卡：白卡撑满卡片区、内容垂直居中，面包屑 + 均衡断行的大标题 + 灰色副标题 */
export const Title: React.FC<TemplateProps<'title'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const compact = React.useContext(SurfaceContext) === 'float';
  const px = titlePx(props.title, compact);
  const subPx = props.subtitle ? fitFontSize(props.subtitle, INNER_W, 46, 30, 2) : 46;
  return (
    <SafeArea>
      <CardFrame fill padding={`64px ${PAD_X}px 68px`}>
        {props.crumb ? <Reveal p={springAt(local, 0.05, fps)} dy={12}><Crumb text={props.crumb} size={30} maxWidth={INNER_W} /></Reveal> : null}
        <Reveal p={springAt(local, 0.1, fps)} dy={28}>
          <div style={{ marginTop: props.crumb ? 34 : 0, fontSize: px, fontWeight: 800, lineHeight: 1.16, letterSpacing: '-0.015em', overflowWrap: 'anywhere', ...clampLines(3) }}>
            {titleLines(props.title, compact).map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </Reveal>
        {props.subtitle ? (
          <Reveal p={springAt(local, 0.2, fps)} dy={24}>
            <div style={{ marginTop: 30, fontSize: subPx, fontWeight: 500, lineHeight: 1.4, color: THEME.sub, ...clampLines(2) }}>{props.subtitle}</div>
          </Reveal>
        ) : null}
      </CardFrame>
    </SafeArea>
  );
};
