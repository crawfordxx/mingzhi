/**
 * 剪辑直播的深色终端（叠在右侧预览画框左下，G1 的终端叠放）：
 * 命令行（v1）或修改摘要（v2+）→ 各步骤逐行打出（转圈 → ✓ + 用时）→ 抠像/渲染带进度条 → 收尾「原片 → 成片 · 镜头数 · 花费」。
 * 转录与被剪掉的词在左侧直播卡里（LiveTranscript）。
 * 读屏只播报「步骤切换」（单独的隐藏 live 区），转圈字符对读屏隐藏。
 */
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { fmtDuration, yuan } from '../lib/media';
import type { LiveView, StepLine } from '../lib/liveModel';
import { Lights, SOFT } from '../ui';

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

function Spinner() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setI((x) => (x + 1) % SPIN.length), 90);
    return () => window.clearInterval(id);
  }, []);
  return <span className="sp" aria-hidden="true">{SPIN[i]} </span>;
}

const elapsed = (s: StepLine): string => {
  if (s.t1 === undefined) return '';
  const sec = (s.t1 - s.t0) / 1000;
  if (sec < 0.1) return '';
  return sec < 10 ? `${sec.toFixed(1)}s` : fmtDuration(sec);
};

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 去掉消息里与步骤名重复的开头（「识别 63 字」→「63 字」） */
export const tidy = (s: StepLine): string => s.message.replace(new RegExp(`^${escapeRe(s.label)}[：:\\s]*`), '');

function Step({ s }: { s: StepLine }) {
  const head = s.state === 'run' ? <Spinner /> : s.state === 'fail' ? <span className="neg">✗ </span> : <span className="ok">✓ </span>;
  return (
    <div className="ln typed">
      {head}<span className="k">{s.label}</span>{'  '}
      <span className={s.state === 'fail' ? 'neg' : 'd'}>{tidy(s)}</span>
      {s.state === 'run' && s.pct !== undefined && (
        <>
          <span className="tw-bar"><motion.i initial={false} animate={{ width: `${s.pct}%` }} transition={SOFT} /></span>
          <span className="pct">{s.pct}%</span>
        </>
      )}
      {s.state === 'ok' && elapsed(s) && <span className="d"> · {elapsed(s)}</span>}
    </div>
  );
}

/** 读屏播报：只在当前步骤变化时说一句 */
function Announce({ view }: { view: LiveView }) {
  const cur = view.steps.at(-1);
  const text = view.status === 'done' ? '剪辑完成' : view.status === 'failed' ? `出片失败：${view.error ?? ''}` : cur ? `正在${cur.label}` : '';
  return <span className="sr" role="status" aria-live="polite">{text}</span>;
}

interface Props {
  view: LiveView;
  title: string;
  /** v1：真实的 mingzhi 命令；v2+：修改摘要（没有对应 CLI） */
  command?: string;
  comment?: string;
  animate: boolean;
  place: { left: number; width: number; bottom: number };
}

export function LiveTerminal({ view, title, command, comment, animate, place }: Props) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: animate ? 'smooth' : 'auto' });
  }, [view.steps.length, view.status, animate]);
  return (
    <motion.div className={`tw term${animate ? '' : ' still'}`} style={place} initial={{ opacity: 0, y: 24, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.96 }} transition={SOFT}>
      <div className="titlebar"><Lights size={10} /><span className="tt">Terminal — {title} — 100×30</span></div>
      <div className="term-body" ref={body}>
        {command && <div className="ln typed"><span className="p">$ </span>{command}</div>}
        {comment && <div className="ln typed"><span className="p"># </span>{comment}</div>}
        {view.status === 'queued' && <div className="ln"><Spinner /><span className="d">排队中，前面的任务完成后马上开始</span></div>}
        {view.steps.map((s) => <Step key={s.step} s={s} />)}
        {view.status === 'done' && (
          <>
            <div className="ln typed"><span className="p">→ </span>
              {view.sourceSec !== undefined ? fmtDuration(view.sourceSec) : '—'} → {view.outputSec !== undefined ? fmtDuration(view.outputSec) : '—'}
              {view.shots.length ? ` · ${view.shots.length} 个镜头` : ''}{view.cost ? ` · ${yuan(view.cost.total)}` : ''}</div>
            <div className="ln"><span className="p">$ </span><span className="caret" /></div>
          </>
        )}
      </div>
      <Announce view={view} />
    </motion.div>
  );
}
