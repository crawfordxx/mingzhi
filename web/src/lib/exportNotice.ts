import type { ExportResult } from '../api';

export interface ExportNotice {
  text: string;
  /** copy：可复制署名文本；ack：署名记录读不出来的警告，需要用户确认看到 */
  action?: 'copy' | 'ack';
}

/** 导出成功后的提示：有署名文本就提供复制；署名记录读不出来时明确警告（不能静默发布无署名的成片） */
export function exportNotice(out: ExportResult, dir: string): ExportNotice {
  const name = out.files[0]?.split(/[\\/]/).pop() ?? '';
  const done = `已导出 ${out.files.length} 个文件到「${dir}」 · ${name}`;
  if (out.attributionError) return { text: `${done} · ⚠ ${out.attributionError}`, action: 'ack' };
  return out.attribution ? { text: done, action: 'copy' } : { text: done };
}
