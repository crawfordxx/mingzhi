/**
 * 直播卡里的转录：识别出的句子逐行出现；剪口误一出来，被剪的词先标红划掉、停一下再收拢消失（整句被剪的整行收起）。
 * 字幕校对完成后换成校对后的字幕文字（「税后」→「睡前」、「ai」→「AI」），被剪的词按 token 区间标回原处，仍划掉。
 * animate=false（打开早已完成的版本）时直接给剪完的样子。
 */
import { useEffect, useRef } from 'react';
import { captionRows, transcriptRows, type TxRow } from '../lib/captionRows';
import type { LiveView } from '../lib/liveModel';

function Line({ row, order }: { row: TxRow; order: number }) {
  const gone = row.parts.length > 0 && row.parts.every((p) => p.cut);
  const delay = { ['--d' as string]: `${1.3 + order * 0.22}s` };
  return (
    <li className={`tx typed${gone ? ' gone' : ''}`} style={gone ? delay : undefined}>
      {row.parts.map((p, i) => (p.cut ? <span key={i} className="cutw" style={delay}><span>{p.text}</span></span> : <span key={i}>{p.text}</span>))}
    </li>
  );
}

export function LiveTranscript({ view, animate }: { view: LiveView; animate: boolean }) {
  const box = useRef<HTMLOListElement>(null);
  const polished = view.captions.length > 0;
  const rows = polished ? captionRows(view.captions, view.transcript, view.cuts) : transcriptRows(view.transcript, view.cuts);
  useEffect(() => {
    const el = box.current;
    if (el && animate) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [rows.length, animate]);
  if (!view.transcript.length) return null;
  return (
    <div className={`tx-wrap${animate ? '' : ' still'}`}>
      <div className="tx-h"><span>{polished ? '转录 · 已校对' : '转录'}</span><span className="tx-key"><i />剪掉的词</span></div>
      <ol className="tx-list" ref={box}>
        {rows.map((r, i) => <Line key={r.key} row={r} order={i} />)}
      </ol>
    </div>
  );
}
