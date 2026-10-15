/**
 * 修改版本出片中（G1「处理中」卡）：标题是这次修改的摘要，旁注写要重跑哪些阶段；
 * 中间一条进度（抠像/渲染有百分比，其余步骤显示不定进度），底部「正在：…」与「已用 · 花费」。
 */
import { AnimatePresence, motion } from 'motion/react';
import type { VersionMeta, WorkEvent } from '../api';
import { fmtDuration, yuan } from '../lib/media';
import { reduceLive, type ShotInfo } from '../lib/liveModel';
import { It, Num, SOFT, Tap, useNow } from '../ui';
import { Strip } from './ShotStrip';

/** edit 事件：「修改：xxx · 应用 1 项修改 · 重跑：成片」→ 取「重跑：…」 */
const rerunOf = (events: WorkEvent[]): string | undefined => /重跑：([^·]+)/.exec(events.find((e) => e.step === 'edit')?.message ?? '')?.[1]?.trim();

interface Props {
  meta: VersionMeta; events: WorkEvent[]; onCancel?: () => void;
  /** 基础版本的分镜与要重渲的镜头（来自这一轮执行的操作） */
  shots?: ShotInfo[]; hot?: ReadonlySet<number>; backdrop?: string;
}

export function RunCard({ meta, events, onCancel, shots, hot, backdrop }: Props) {
  const view = reduceLive(events);
  // 以版本状态为准：服务重启后版本已是 failed，就算事件流里没有终止事件也停止计时
  const running = meta.status === 'running' && view.status !== 'failed' && view.status !== 'done';
  const now = useNow(running);
  const cur = [...view.steps].reverse().find((s) => s.state === 'run') ?? view.steps.at(-1);
  const pct = cur?.pct;
  const used = view.t0 ? ((view.t1 ?? now) - view.t0) / 1000 : 0;
  const rerun = rerunOf(events);
  const failed = meta.status === 'failed' || view.status === 'failed';
  return (
    <div className={`card run${failed ? ' failed' : ''}`}>
      <div className="run-h">
        <b>v{meta.n} · {meta.summary}</b>
        {rerun && <It l className="run-it">(重跑：{rerun})</It>}
        {running && onCancel && <Tap className="btn btn-g sm" onClick={onCancel}>取消</Tap>}
      </div>
      {running && shots?.length && hot?.size ? <Strip shots={shots} backdrop={backdrop} animate={false} hot={hot} /> : null}
      <div className="prog">
        <span className="t">{failed ? '没有完成' : view.status === 'queued' || !cur ? '排队中' : `${cur.label}中`}</span>
        <span className={`track${pct === undefined && running ? ' indet' : ''}`}>
          <motion.i initial={false} animate={{ width: `${failed ? 100 : pct ?? (running ? 32 : 100)}%` }} transition={SOFT} />
        </span>
        <span className="pct">{pct !== undefined ? <Num value={pct} format={(x) => `${Math.round(x)}%`} /> : ''}</span>
      </div>
      <div className="proc-f">
        {/* 等待时的说明文字交叉淡入（Uber 加载页的副标题轮换） */}
        <span className="run-msg">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={failed ? 'f' : cur?.step ?? 'q'} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}>
              {failed ? view.error ?? '出片失败' : cur ? `正在：${cur.message}` : '等前面的任务完成'}
            </motion.span>
          </AnimatePresence>
        </span>
        <span>已用 {fmtDuration(used)} · 花费 {view.cost ? <Num value={view.cost.total} format={yuan} /> : yuan(0)}</span>
      </div>
    </div>
  );
}
