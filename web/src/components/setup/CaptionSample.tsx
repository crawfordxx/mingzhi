/**
 * 字幕样式示例：后端给了预览图（CaptionStill 渲染的 1080×600 整图，字幕在中线）就裁出字幕带显示，
 * 否则用 CSS 占位（见 lib/captionLook.ts）。预览窗里叠在所选背景上时只用 CSS 版
 */
import { captionCss, SAMPLE } from '../../lib/captionLook';

export function CaptionSample({ id, preview, size }: { id: string; preview?: string; size: number }) {
  if (preview) return <span className="cap-img"><img src={preview} alt="" draggable={false} loading="lazy" /></span>;
  const { text, hot } = captionCss(id, size);
  return (
    <span className="cap-css" style={text} aria-hidden="true">
      {SAMPLE.before}<span style={hot}>{SAMPLE.hot}</span>{SAMPLE.after}
    </span>
  );
}
