/**
 * 右侧大预览：油画画框 + 9:16 白色 macOS 浮窗 + 深色终端窗（G1 招牌构图）。
 * - 还没有成片：浮窗示意当前设置，终端拼出命令；出片中终端跟着直播
 * - 有成片：浮窗播放当前版本（顶部 v1/v2/v3 切换）；对比打开后左右同步播放
 * - 重播 v1 剪辑过程时，画面跟着分镜逐张出现的进度跳
 */
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Estimate, Options, Space, VersionMeta } from '../api';
import { reduceLive, type QaScore } from '../lib/liveModel';
import type { TimeRef } from '../lib/shots';
import { PLAYER_CHROME, stageLayout } from '../lib/stageLayout';
import type { Replay } from '../live';
import type { Clock } from '../usePlayback';
import type { Runs } from '../useRuns';
import { Ico, It, SOFT, Tap } from '../ui';
import { CompareView } from './CompareView';
import { PlayerWindow } from './PlayerWindow';
import { artFor } from './SpacesRail';
import { StageTerminal, type StageLive } from './StageTerminal';
import { VersionPlayer } from './VersionPlayer';
import { VersionSwitcher } from './VersionSwitcher';

function useFrameSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, size };
}

/** 对比时两个浮窗的画面高度：留出上下边距与底部的差异胶囊，且两个并排放得下 */
const pairHeight = (w: number, h: number): number => Math.max(220, Math.min(h - 72 - PLAYER_CHROME - 50, (((w - 72) / 2 - 16) * 16) / 9));

function heading(space: Space, meta: VersionMeta | undefined, replaying: boolean, totalShots?: number): [string, string] {
  if (!meta) return ['预览', space.job || space.versions.some((v) => v.status === 'running') ? '(v1 出片中 · 剪辑直播在左侧)' : '(设置示意 · 还没有成片)'];
  if (replaying) return [`v${meta.n}`, '(重播 v1 剪辑过程)'];
  const k = meta.changedShots.length;
  const what = meta.n === 1 ? '首版' : /^回退到/.test(meta.summary) ? meta.summary : totalShots && k >= totalShots ? '全部重渲' : `只重渲了 ${k} 段`;
  return [`v${meta.n}`, `(${what}${meta.qaScore !== undefined ? ` · 自检 ${meta.qaScore.toFixed(1)}` : ''})`];
}

/** 每个版本各镜头的自检分（取该版本或更早版本最近一次打分） */
function useScores(runs: Runs, versions: VersionMeta[]) {
  return useMemo(() => {
    const byVersion = new Map(versions.map((v) => [v.n, reduceLive(runs.eventsOf(v.n)).qa]));
    const avg = (q: QaScore) => (q.layout + q.hierarchy + q.motion + q.brand) / 4;
    return (n: number) => (i: number) => {
      for (let k = n; k >= 1; k -= 1) { const q = byVersion.get(k)?.[i]; if (q) return avg(q); }
      return undefined;
    };
  }, [runs, versions]);
}

interface Props {
  space: Space; options: Options; estimate?: Estimate; totalSec: number;
  runs: Runs; clock: Clock; replay: Replay; onRef: (r: TimeRef, from: { x: number; y: number }) => void; notify: (m: string) => void;
}

export function PreviewStage({ space, options, estimate, totalSec, runs, clock, replay, onRef, notify }: Props) {
  const { ref, size } = useFrameSize();
  const lay = size ? stageLayout(size.w, size.h) : undefined;
  const done = space.versions.filter((v) => v.status === 'done');
  const meta = runs.viewMeta;
  const state = meta ? runs.stateOf(meta.n) : undefined;
  const replaying = replay.shown !== undefined;
  const [h2, aside] = heading(space, meta, replaying, state?.storyboard.shots.length);
  const scoreOf = useScores(runs, done);
  const activeMeta = space.versions.find((v) => v.n === runs.active);
  const live: StageLive | undefined = runs.active ? { view: reduceLive(runs.eventsOf(runs.active)), n: runs.active, summary: activeMeta?.summary } : undefined;
  const left = done.find((v) => v.n === runs.compareWith);

  // 重播时画面跟着分镜进度跳到最新一张卡
  const replayShots = replay.shown ? reduceLive(replay.shown).shots : [];
  const lastStart = replayShots.at(-1)?.start;
  const seek = useRef(clock.seek);
  seek.current = clock.seek;
  useEffect(() => { if (lastStart !== undefined) seek.current(lastStart + 0.05); }, [lastStart]);

  return (
    <section className="pane" aria-label="预览">
      <div className="pane-h">
        <h2>{h2}<It l>{aside}</It></h2>
        <div className="ctrls">
          {done.length ? (
            <VersionSwitcher versions={space.versions} view={runs.view} active={runs.active} onView={runs.setView}
              compare={runs.compare} canCompare={runs.canCompare} onCompare={runs.setCompare} onBusy={notify} />
          ) : (
            <div className="seg" title="出片后可在这里切换版本"><button type="button" aria-disabled="true">{runs.active && <span className="pulse" />}v1</button></div>
          )}
          <Tap className="btn btn-k" disabled={!meta || runs.exporting !== undefined} onClick={() => meta && void runs.exportVersion(meta.n)}
            title={meta ? `导出 v${meta.n}：成片与两张封面` : '出片后可导出'}>{runs.exporting !== undefined ? <span className="spin" /> : Ico.down}导出</Tap>
        </div>
      </div>
      <motion.div ref={ref} className="frame" style={{ backgroundImage: `url('${artFor(space.id)}')` }}
        initial={{ opacity: 0, scale: 0.985 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...SOFT, delay: 0.05 }}>
        {size && lay && (meta ? (runs.compare && left ? (
          <CompareView spaceId={space.id} left={{ meta: left, state: runs.stateOf(left.n) }} right={{ meta, state }} clock={clock} h={pairHeight(size.w, size.h)} scoreOf={scoreOf} onRef={onRef} />
        ) : (
          <div className="stagewin">
            <VersionPlayer key="one" spaceId={space.id} meta={meta} state={state} clock={clock} h={lay.h} scoreOf={scoreOf(meta.n)}
              locked={replaying} onRef={onRef} style={{ left: lay.left, top: lay.top }} />
          </div>
        )) : (
          <div className="stagewin"><PlayerWindow space={space} options={options} lay={lay} totalSec={totalSec} /></div>
        ))}
        <AnimatePresence>
          {lay && !runs.compare && (!meta || live) && (
            <StageTerminal key={live ? `live-${live.n}` : 'setup'} space={space} options={options} estimate={estimate} totalSec={totalSec} place={lay.term} live={live} />
          )}
        </AnimatePresence>
      </motion.div>
    </section>
  );
}
