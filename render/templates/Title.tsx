import React from 'react';
import { useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { CONTENT_W, CardFrame, Crumb, Reveal, SafeArea, clampLines, fitFontSize, springAt, type TemplateProps } from './parts.js';

const PAD_X = 64;
const INNER_W = CONTENT_W - PAD_X * 2;

/** 标题卡：白卡居中，面包屑 + 大标题 + 灰色副标题 */
export const Title: React.FC<TemplateProps<'title'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const titlePx = fitFontSize(props.title, INNER_W, 72, 40, 3);
  const subPx = props.subtitle ? fitFontSize(props.subtitle, INNER_W, 40, 26, 2) : 40;
  return (
    <SafeArea>
      <CardFrame padding={`64px ${PAD_X}px 68px`}>
        {props.crumb ? <Reveal p={springAt(local, 0.05, fps)} dy={12}><Crumb text={props.crumb} maxWidth={INNER_W} /></Reveal> : null}
        <Reveal p={springAt(local, 0.1, fps)} dy={28}>
          <div style={{ marginTop: props.crumb ? 28 : 0, fontSize: titlePx, fontWeight: 800, lineHeight: 1.18, letterSpacing: '-0.015em', ...clampLines(3) }}>{props.title}</div>
        </Reveal>
        {props.subtitle ? (
          <Reveal p={springAt(local, 0.2, fps)} dy={24}>
            <div style={{ marginTop: 22, fontSize: subPx, fontWeight: 500, lineHeight: 1.4, color: THEME.sub, ...clampLines(2) }}>{props.subtitle}</div>
          </Reveal>
        ) : null}
      </CardFrame>
    </SafeArea>
  );
};
