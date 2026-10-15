/**
 * 画上的深色终端（ego 的终端叠放）。
 * 出片前：把当前设置拼成一条真实的 mingzhi 命令，参数一变就闪一下；
 * 出片中：跟着事件直播显示最近几步、当前进度条与花费（修改版本没有对应的 CLI 命令，只写注释行）。
 */
import { AnimatePresence, motion } from 'motion/react';
import type { Estimate, Options, Space } from '../api';
import { cliArgs } from '../lib/cli';
import type { LiveView } from '../lib/liveModel';
import { fmtDuration, yuan } from '../lib/media';
import { Lights, SOFT } from '../ui';
import { backgroundLabel, DEFAULT_COVER } from './SetupCard';

/** 参数值变化时以浅蓝底闪现一次 */
const Arg = ({ flag, value }: { flag: string; value: string }) => (
  <>{' '}<span className="arg">
    <span className="d">{flag} </span>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={value} className="v" initial={{ backgroundColor: 'rgba(133,160,224,.55)', opacity: 0 }}
        animate={{ backgroundColor: 'rgba(133,160,224,0)', opacity: 1 }} transition={{ duration: 0.9, ease: 'easeOut' }}>{value}</motion.span>
    </AnimatePresence>
  </span></>
);

export interface StageLive { view: LiveView; n: number; summary?: string }

interface Props { space: Space; options: Options; estimate?: Estimate; totalSec: number; place: { left: number; width: number; bottom: number }; live?: StageLive }

function Command({ space }: { space: Space }) {
  const files = space.inputs;
  return (
    <div className="cmd">
      <span className="p">$ </span>mingzhi edit
      {files.length ? <span className="v"> {files[0]}</span> : <span className="d"> &lt;口播视频&gt;</span>}
      {cliArgs(space).map((a) => <Arg key={a.flag} flag={a.flag} value={a.value} />)}
    </div>
  );
}

/** 出片中：最近三步 + 进度 + 花费 */
function LiveLines({ live }: { live: StageLive }) {
  const { view, n } = live;
  const recent = view.steps.slice(-3);
  const cur = recent.at(-1);
  return (
    <>
      {recent.map((s) => (
        <div key={s.step} className={`ln1${s.state === 'run' ? '' : ' d'}`}>
          {s.state === 'run' ? <span className="y">⠹ </span> : <span className="p">✓ </span>}{s.label}
          {s.state === 'run' && s.pct !== undefined
            ? <> <span className="tw-bar"><motion.i initial={false} animate={{ width: `${s.pct}%` }} transition={SOFT} /></span>{s.pct}%</>
            : <span className="d"> · {s.message.replace(new RegExp(`^${s.label}[：:\\s]*`), '')}</span>}
        </div>
      ))}
      <div className="d">  ⎿ {view.cost ? `已花 ${yuan(view.cost.total)} · ` : ''}{cur ? '' : '排队中 · '}完成后出 v{n}</div>
    </>
  );
}

export function StageTerminal({ space, options, estimate, totalSec, place, live }: Props) {
  const files = space.inputs;
  const coverId = space.settings.coverStyle ?? DEFAULT_COVER;
  const names = [space.settings.background ? backgroundLabel(space, options).name : '原背景',
    options.captionStyles.find((c) => c.id === space.settings.captionStyle)?.name, options.coverStyles.find((c) => c.id === coverId)?.name].filter(Boolean).join(' · ');
  const est = estimate && estimate.high > 0 ? `${yuan(estimate.low)}–${yuan(estimate.high)}` : '—';
  const title = live ? `v${live.n}` : space.title;
  return (
    <motion.div className="tw" style={place} initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.96 }} transition={{ ...SOFT, delay: live ? 0 : 0.32 }}>
      <div className="titlebar"><Lights size={10} /><span className="tt">Terminal — {title} — 100×30</span></div>
      <div className="tw-body">
        {live && live.n > 1 ? <div><span className="p"># </span>v{live.n} · {live.summary ?? '对话修改'}</div> : <Command space={space} />}
        {!live && <div className="d">  # {names}{files.length > 1 ? ` · 共 ${files.length} 段` : ''}</div>}
        {!live && <div className="d">  ⎿ {files.length ? `${files.length} 段口播${totalSec > 0 ? ` · ${fmtDuration(totalSec)}` : ''}` : '还没有口播'} · 预估 {est}</div>}
        {live ? <LiveLines live={live} /> : <div><span className="d">  ⎿ 等待「开始出片」</span> <span className="caret" /></div>}
      </div>
    </motion.div>
  );
}
