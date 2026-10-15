/**
 * 剪辑直播的深色终端：命令行 → 各步骤逐行打出（转圈 → ✓ + 用时）→ 识别出的转录逐行出现，
 * 被剪掉的词先标红划掉、再收拢消失 → 进度条步骤带百分比 → 收尾一行「原片 → 成片 · 段数 · 花费」。
 * animate=false（打开一个早已完成的版本）时直接给最终画面，不放动画。
 */
import { useEffect, useRef, useState } from 'react';
import { fmtDuration, yuan } from '../lib/media';
import { cutTokenSet, type LiveView, type StepLine, type TxLine } from '../lib/liveModel';
import { Lights } from '../ui';

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

function Spinner() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setI((x) => (x + 1) % SPIN.length), 90);
    return () => window.clearInterval(id);
  }, []);
  return <span className="sp">{SPIN[i]} </span>;
}

const elapsed = (s: StepLine): string => {
  if (s.t1 === undefined) return '';
  const sec = (s.t1 - s.t0) / 1000;
  if (sec < 0.1) return '';
  return sec < 10 ? `${sec.toFixed(1)}s` : fmtDuration(sec);
};

/** 去掉消息里与步骤名重复的开头（「识别 63 字」→「63 字」） */
const tidy = (s: StepLine): string => s.message.replace(new RegExp(`^${s.label}[：:\\s]*`), '');

function Step({ s }: { s: StepLine }) {
  const head = s.state === 'run' ? <Spinner /> : s.state === 'fail' ? <span className="neg">✗ </span> : <span className="ok">✓ </span>;
  return (
    <div className="ln typed">
      {head}<span className="k">{s.label}</span>{'  '}
      <span className={s.state === 'fail' ? 'neg' : 'd'}>{tidy(s)}</span>
      {s.state === 'run' && s.pct !== undefined && <><span className="tw-bar"><i style={{ width: `${s.pct}%` }} /></span><span className="pct">{s.pct}%</span></>}
      {s.state === 'ok' && elapsed(s) && <span className="d"> · {elapsed(s)}</span>}
    </div>
  );
}

/** 一行转录：被剪的 token 划掉后收拢（第 i 行的收拢稍晚一点，像一行行被剪） */
function Tx({ line, cut, order }: { line: TxLine; cut: ReadonlySet<number>; order: number }) {
  const parts: { text: string; cut: boolean }[] = [];
  line.tokens.forEach((tok, k) => {
    const isCut = cut.has(line.from + k);
    const last = parts.at(-1);
    if (last && last.cut === isCut) parts[parts.length - 1] = { ...last, text: last.text + tok };
    else parts.push({ text: tok, cut: isCut });
  });
  const gone = parts.length > 0 && parts.every((p) => p.cut);
  return (
    <div className={`ln tx typed${gone ? ' gone' : ''}`} style={gone ? { ['--d' as string]: `${1.3 + order * 0.22}s` } : undefined}>
      <span className="d">⎿ </span>
      {parts.map((p, i) => (p.cut
        ? <span key={i} className="cutw" style={{ ['--d' as string]: `${1.3 + order * 0.22}s` }}><span>{p.text}</span></span>
        : <span key={i}>{p.text}</span>))}
    </div>
  );
}

interface Props { view: LiveView; title: string; command?: string; animate: boolean }

export function LiveTerminal({ view, title, command, animate }: Props) {
  const body = useRef<HTMLDivElement>(null);
  const cut = cutTokenSet(view.cuts);
  const rows = view.steps.length + view.transcript.length + (view.cuts.length ? 1 : 0);
  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: animate ? 'smooth' : 'auto' });
  }, [rows, view.status, animate]);
  return (
    <div className={`term${animate ? '' : ' still'}`}>
      <div className="titlebar"><Lights size={10} /><span className="tt">Terminal — {title} — 100×30</span></div>
      <div className="term-body" ref={body} aria-live="polite">
        {command && <div className="ln typed"><span className="p">$ </span>{command}</div>}
        {view.status === 'queued' && <div className="ln"><Spinner /><span className="d">排队中，前面的任务完成后马上开始</span></div>}
        {view.steps.map((s) => (
          <div key={s.step}>
            <Step s={s} />
            {s.step === 'asr' && view.transcript.map((l, i) => <Tx key={l.from} line={l} cut={cut} order={i} />)}
          </div>
        ))}
        {view.status === 'done' && (
          <>
            <div className="ln typed"><span className="p">→ </span>{view.sourceSec !== undefined ? fmtDuration(view.sourceSec) : '—'} → {view.outputSec !== undefined ? fmtDuration(view.outputSec) : '—'}
              {view.shots.length ? ` · ${view.shots.length} 段` : ''}{view.cost ? ` · ${yuan(view.cost.total)}` : ''}</div>
            <div className="ln"><span className="p">$ </span><span className="caret" /></div>
          </>
        )}
      </div>
    </div>
  );
}
