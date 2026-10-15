/**
 * 画上的深色终端（ego 的终端叠放）。
 * 出片前：把当前设置拼成一条真实的 mingzhi 命令，参数一变就闪一下。
 * 出片中与重播时换成 LiveTerminal（剪辑直播的终端）。
 */
import { AnimatePresence, motion } from 'motion/react';
import type { Estimate, Options, Space } from '../api';
import { cliArgs } from '../lib/cli';
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

interface Props { space: Space; options: Options; estimate?: Estimate; totalSec: number; place: { left: number; width: number; bottom: number } }

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

export function StageTerminal({ space, options, estimate, totalSec, place }: Props) {
  const files = space.inputs;
  const coverId = space.settings.coverStyle ?? DEFAULT_COVER;
  const names = [space.settings.background ? backgroundLabel(space, options).name : '原背景',
    options.captionStyles.find((c) => c.id === space.settings.captionStyle)?.name, options.coverStyles.find((c) => c.id === coverId)?.name].filter(Boolean).join(' · ');
  const est = estimate && estimate.high > 0 ? `${yuan(estimate.low)}–${yuan(estimate.high)}` : '—';
  return (
    <motion.div className="tw" style={place} initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.96 }} transition={{ ...SOFT, delay: 0.32 }}>
      <div className="titlebar"><Lights size={10} /><span className="tt">Terminal — {space.title} — 100×30</span></div>
      <div className="tw-body">
        <Command space={space} />
        <div className="d">  # {names}{files.length > 1 ? ` · 共 ${files.length} 段` : ''}</div>
        <div className="d">  ⎿ {files.length ? `${files.length} 段口播${totalSec > 0 ? ` · ${fmtDuration(totalSec)}` : ''}` : '还没有口播'} · 预估 {est}</div>
        <div><span className="d">  ⎿ 等待「开始出片」</span> <span className="caret" /></div>
      </div>
    </motion.div>
  );
}
