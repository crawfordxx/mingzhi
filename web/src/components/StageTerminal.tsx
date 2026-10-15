/** 画上的深色终端：把当前设置拼成一条 mingzhi 命令，参数一变就闪一下（ego 的终端叠放） */
import { AnimatePresence, motion } from 'motion/react';
import type { Estimate, Options, Space } from '../api';
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

/** 与 src/cli.ts 一致的真实命令：mingzhi edit <口播> --bg <预设id|图片> | --bg-prompt "…" --caption-style <id> --cover-style <id> --budget <元> */
function bgArg(space: Space): { flag: string; value: string } | undefined {
  const bg = space.settings.background;
  if (!bg) return undefined;
  if (bg.kind === 'preset') return { flag: '--bg', value: bg.id };
  if (bg.kind === 'file') return { flag: '--bg', value: bg.path.split(/[\\/]/).pop() ?? bg.path };
  return { flag: '--bg-prompt', value: `"${bg.prompt}"` };
}

export function StageTerminal({ space, options, estimate, totalSec, place }: Props) {
  const s = space.settings;
  const files = space.inputs;
  const capId = s.captionStyle;
  const coverId = s.coverStyle ?? DEFAULT_COVER;
  const names = [space.settings.background ? backgroundLabel(space, options).name : '原背景',
    options.captionStyles.find((c) => c.id === capId)?.name, options.coverStyles.find((c) => c.id === coverId)?.name].filter(Boolean).join(' · ');
  const bg = bgArg(space);
  const running = !!space.job || space.versions.at(-1)?.status === 'running';
  const est = estimate && estimate.high > 0 ? `${yuan(estimate.low)}–${yuan(estimate.high)}` : '—';

  return (
    <motion.div className="tw" style={place} initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ ...SOFT, delay: 0.32 }}>
      <div className="titlebar"><Lights size={10} /><span className="tt">Terminal — {space.title} — 100×30</span></div>
      <div className="tw-body">
        <div className="cmd">
          <span className="p">$ </span>mingzhi edit
          {files.length ? <span className="v"> {files[0]}</span> : <span className="d"> &lt;口播视频&gt;</span>}
          {bg && <Arg flag={bg.flag} value={bg.value} />}
          <Arg flag="--caption-style" value={capId} />
          <Arg flag="--cover-style" value={coverId} />
          <Arg flag="--budget" value={String(s.budgetYuan)} />
        </div>
        <div className="d">  # {names}{files.length > 1 ? ` · 共 ${files.length} 段` : ''}</div>
        <div className="d">  ⎿ {files.length ? `${files.length} 段口播${totalSec > 0 ? ` · ${fmtDuration(totalSec)}` : ''}` : '还没有口播'} · 预估 {est}</div>
        <div>{running ? <><span className="y">⠹</span> 已开始出 v1…</> : <><span className="d">  ⎿ 等待「开始出片」</span> <span className="caret" /></>}</div>
      </div>
    </motion.div>
  );
}
