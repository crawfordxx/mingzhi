/** 字幕样式示例：后端给了预览图就用图，否则用 CSS 占位（见 lib/captionLook.ts） */
import { captionCss, SAMPLE } from '../../lib/captionLook';

export function CaptionSample({ id, preview, size }: { id: string; preview?: string; size: number }) {
  if (preview) return <img className="cap-img" src={preview} alt="" draggable={false} />;
  const { text, hot } = captionCss(id, size);
  return (
    <span className="cap-css" style={text} aria-hidden="true">
      {SAMPLE.before}<span style={hot}>{SAMPLE.hot}</span>{SAMPLE.after}
    </span>
  );
}
