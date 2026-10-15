/**
 * 右侧大预览：油画画框 + 9:16 白色 macOS 浮窗 + 深色终端窗（G1 招牌构图）。
 * 还没有成片时，浮窗实时示意所选背景与字幕样式，终端把当前设置拼成一条命令；
 * 版本切换、对比、剪辑直播与 @时间 插入在下一个任务接入，这里只留位置。
 */
import { motion } from 'motion/react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Estimate, Options, Space } from '../api';
import { stageLayout } from '../lib/stageLayout';
import { Ico, It, SOFT } from '../ui';
import { PlayerWindow } from './PlayerWindow';
import { artFor } from './SpacesRail';
import { StageTerminal } from './StageTerminal';

function useFrameSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, size };
}

interface Props { space: Space; options: Options; estimate?: Estimate; totalSec: number }

export function PreviewStage({ space, options, estimate, totalSec }: Props) {
  const { ref, size } = useFrameSize();
  const lay = size ? stageLayout(size.w, size.h) : undefined;
  const running = space.versions.at(-1)?.status === 'running';

  return (
    <section className="pane" aria-label="预览">
      <div className="pane-h">
        <h2>预览<It l>{running ? '(v1 出片中 · 剪辑直播在左侧)' : '(设置示意 · 还没有成片)'}</It></h2>
        <div className="ctrls">
          <div className="seg" title="出片后可在这里切换版本"><button type="button" aria-disabled="true">{running && <span className="pulse" />}v1</button></div>
          <button type="button" className="btn btn-k" disabled title="出片后可导出">{Ico.down}导出</button>
        </div>
      </div>
      <motion.div ref={ref} className="frame" style={{ backgroundImage: `url('${artFor(space.id)}')` }}
        initial={{ opacity: 0, scale: 0.985 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...SOFT, delay: 0.05 }}>
        <div className="stagewin">
          {lay && <PlayerWindow space={space} options={options} lay={lay} totalSec={totalSec} />}
        </div>
        {lay && <StageTerminal space={space} options={options} estimate={estimate} totalSec={totalSec} place={lay.term} />}
      </motion.div>
    </section>
  );
}
