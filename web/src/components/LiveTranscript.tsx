/**
 * 直播卡里的转录：识别出的句子逐行出现；剪口误一出来，被剪的词先标红划掉、停一下再收拢消失（整句被剪的整行收起）。
 * animate=false（打开早已完成的版本）时直接给剪完的样子。
 */
import { useEffect, useRef } from 'react';
import { cutTokenSet, type LiveView, type TxLine } from '../lib/liveModel';

function Line({ line, cut, order }: { line: TxLine; cut: ReadonlySet<number>; order: number }) {
  const parts: { text: string; cut: boolean }[] = [];
  line.tokens.forEach((tok, k) => {
    const isCut = cut.has(line.from + k);
    const last = parts.at(-1);
    if (last && last.cut === isCut) parts[parts.length - 1] = { ...last, text: last.text + tok };
    else parts.push({ text: tok, cut: isCut });
  });
  const gone = parts.length > 0 && parts.every((p) => p.cut);
  const delay = { ['--d' as string]: `${1.3 + order * 0.22}s` };
  return (
    <li className={`tx typed${gone ? ' gone' : ''}`} style={gone ? delay : undefined}>
      {parts.map((p, i) => (p.cut ? <span key={i} className="cutw" style={delay}><span>{p.text}</span></span> : <span key={i}>{p.text}</span>))}
    </li>
  );
}

export function LiveTranscript({ view, animate }: { view: LiveView; animate: boolean }) {
  const box = useRef<HTMLOListElement>(null);
  const cut = cutTokenSet(view.cuts);
  useEffect(() => {
    const el = box.current;
    if (el && animate) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [view.transcript.length, animate]);
  if (!view.transcript.length) return null;
  return (
    <div className={`tx-wrap${animate ? '' : ' still'}`}>
      <div className="tx-h"><span>转录</span><span className="tx-key"><i />剪掉的词</span></div>
      <ol className="tx-list" ref={box}>
        {view.transcript.map((l, i) => <Line key={l.from} line={l} cut={cut} order={i} />)}
      </ol>
    </div>
  );
}
