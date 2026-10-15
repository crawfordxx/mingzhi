/** 9:16 白色 macOS 浮窗：出片前示意所选背景、人物位置、字幕样式与封面风格（不是成片） */
import { AnimatePresence, motion } from 'motion/react';
import type { Options, Space } from '../api';
import { fmtDuration } from '../lib/media';
import type { StageLayout } from '../lib/stageLayout';
import { Ico, Lights, SOFT } from '../ui';
import { CaptionSample } from './setup/CaptionSample';
import { backgroundLabel, DEFAULT_COVER } from './SetupCard';

/** 字幕中心在 1080×1920 画布的 y=1400（src/captions/styles.ts 的 FULL_CAPTION_Y） */
const CAPTION_TOP = `${(1400 / 1920) * 100}%`;

/**
 * 人物位置示意：无面孔的磨砂玻璃半身像（GPT Image 生成的抽象模特胸像，亮度转透明度）。
 * 底层用同形遮罩做背景模糊，上层叠半透明高光，像一块立在背景前的玻璃，不是真人
 */
const Silhouette = () => (
  <span className="sil" aria-hidden="true"><span className="sil-glass" /><img className="sil-img" src="/art/silhouette.webp" alt="" draggable={false} /></span>
);

function Backdrop({ space, options }: { space: Space; options: Options }) {
  const bg = backgroundLabel(space, options);
  const spec = space.settings.background;
  const label = spec?.kind === 'prompt' ? '一句话生成的背景' : spec ? '上传的背景' : '保留原背景';
  return (
    <AnimatePresence initial={false}>
      <motion.div key={bg.thumb ?? bg.name} className="vid-bg" initial={{ opacity: 0, scale: 1.04 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}>
        {bg.thumb ? <img src={bg.thumb} alt="" draggable={false} /> : <span className="vid-plain"><small>{label}</small>{spec ? bg.name : null}</span>}
      </motion.div>
    </AnimatePresence>
  );
}

interface Props { space: Space; options: Options; lay: StageLayout; totalSec: number }

export function PlayerWindow({ space, options, lay, totalSec }: Props) {
  const s = space.settings;
  const cap = options.captionStyles.find((c) => c.id === s.captionStyle);
  const cover = options.coverStyles.find((c) => c.id === (s.coverStyle ?? DEFAULT_COVER));
  const running = space.versions.at(-1)?.status === 'running';
  return (
    <motion.div className="player" style={{ width: lay.w + 16, left: lay.left, top: lay.top }} initial={{ opacity: 0, y: 28, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ ...SOFT, delay: 0.18 }}>
      <div className="titlebar"><Lights /><span className="tt">{space.title} — 9:16</span></div>
      <div className="vid" style={{ height: lay.h }}>
        <Backdrop space={space} options={options} />
        <Silhouette />
        <div className="vid-cap" style={{ top: CAPTION_TOP }}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={s.captionStyle} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }}>
              <CaptionSample id={s.captionStyle} size={Math.round(lay.w * 0.075)} />
            </motion.span>
          </AnimatePresence>
        </div>
        <span className="hl badge">设置示意</span>
        {cover && <motion.img key={cover.id} className="vid-cover" src={cover.example} alt={`封面：${cover.name}`} initial={{ opacity: 0, rotate: -6, y: 8 }} animate={{ opacity: 1, rotate: -3, y: 0 }} transition={SOFT} />}
      </div>
      <div className="pctl">
        <button type="button" className="pbtn" disabled aria-label="播放（出片后可用）">{Ico.play}</button>
        <span className="ptime"><b>00:00</b> / {totalSec > 0 ? fmtDuration(totalSec) : '--:--'}</span>
        <div className="pbar" aria-hidden="true" />
      </div>
      <div className="pmeta"><span>{backgroundLabel(space, options).name} · {cap?.name ?? s.captionStyle}{cover ? ` · ${cover.name}封面` : ''}</span><span>{running ? '正在出 v1' : '还没有成片'}</span></div>
    </motion.div>
  );
}
