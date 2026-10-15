/**
 * 分镜卡缩略条：每个镜头一张 9:16 小卡（所选背景 + 玻璃人像，分屏镜头上半是一张白卡）。
 * 剪辑直播里逐张弹出；修改出片中时，要重渲的镜头带蓝环和扫光（G1「处理中」卡的选中格）。
 */
import { motion } from 'motion/react';
import { fmtDuration } from '../lib/media';
import type { ShotInfo } from '../lib/liveModel';
import { cardName } from '../lib/shots';
import { SPRING } from '../ui';

const GHOSTS = 12;

interface TileProps { s: ShotInfo; backdrop?: string; animate: boolean; hot?: boolean; onSeek?: (sec: number) => void }

function Tile({ s, backdrop, animate, hot, onSeek }: TileProps) {
  return (
    <motion.button type="button" className={`tile ${s.layout}${hot ? ' hot' : ''}`} disabled={!onSeek} onClick={() => onSeek?.(s.start + 0.01)}
      title={`#${s.index + 1} · ${cardName(s)}${s.title ? `「${s.title}」` : ''} · ${fmtDuration(s.start)}–${fmtDuration(s.end)}`}
      initial={animate ? { opacity: 0, y: 8, scale: 1.18 } : false} animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ ...SPRING, delay: animate ? s.index * 0.07 : 0 }}>
      {backdrop ? <img src={backdrop} alt="" draggable={false} /> : <span className="tile-bg" />}
      <img className="tile-sil" src="/art/silhouette.webp" alt="" draggable={false} />
      {s.layout === 'split' && <span className="tile-card"><i /><i /><i /></span>}
      {hot && <span className="tile-shim" />}
    </motion.button>
  );
}

interface Props { shots: ShotInfo[]; backdrop?: string; animate: boolean; hot?: ReadonlySet<number>; onSeek?: (sec: number) => void }

export function Strip({ shots, backdrop, animate, hot, onSeek }: Props) {
  const n = shots.length || GHOSTS;
  return (
    <div className="strip" style={{ ['--n' as string]: Math.max(n, GHOSTS) }}>
      {shots.length
        ? shots.map((s) => <Tile key={s.index} s={s} backdrop={backdrop} animate={animate} hot={hot?.has(s.index)} onSeek={onSeek} />)
        : Array.from({ length: GHOSTS }, (_, i) => <span key={i} className="tile ghost" style={{ animationDelay: `${i * 0.09}s` }} />)}
    </div>
  );
}
