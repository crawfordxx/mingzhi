/** 工作台外壳：公告条 / Spaces 栏 / 对话流 / 大预览 */
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { spentOf, type Space } from './api';
import { AnnouncementBar } from './components/AnnouncementBar';
import { ChatFlow } from './components/ChatFlow';
import { Composer } from './components/Composer';
import { PreviewStage } from './components/PreviewStage';
import { SpacesRail } from './components/SpacesRail';
import { reduceLive } from './lib/liveModel';
import { cardName, refSecond, shotIndexAt, type TimeRef } from './lib/shots';
import { useReplay } from './live';
import { useConversation } from './useConversation';
import { usePlayback } from './usePlayback';
import { useRuns } from './useRuns';
import { useWorkbench } from './useWorkbench';
import { It, SPRING } from './ui';

/** 文件拖到拖入区以外时，阻止浏览器直接打开视频、把工作台换掉 */
function useBlockFileDrop() {
  useEffect(() => {
    const stop = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, []);
}

/** 空格键播放/暂停（焦点在输入框、按钮上时不抢） */
function useSpaceToggle(toggle: () => void, enabled: boolean) {
  const fn = useRef(toggle);
  fn.current = toggle;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.code !== 'Space' || e.repeat || (el && el.closest('input, textarea, button, [role=slider], a'))) return;
      e.preventDefault();
      fn.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** 公告条的「本项目已花」：已入账的 + 正在出的版本此刻的花费（跟着直播跳） */
const liveSpent = (space: Space | undefined, running: number): number => spentOf(space) + running;

export function App() {
  const wb = useWorkbench();
  useBlockFileDrop();
  const { space, options } = wb;
  const runs = useRuns({ space, putSpace: wb.putSpace, notify: wb.notify });
  const clock = usePlayback();
  const replay = useReplay(runs.eventsOf(1));
  const convo = useConversation({ space, base: runs.view, busy: runs.active !== undefined, notify: wb.notify, refresh: runs.refresh });
  const totalSec = wb.estimate?.durationSec ?? 0;
  const runningCost = runs.active ? reduceLive(runs.eventsOf(runs.active)).cost?.total ?? 0 : 0;
  const ready = !!space?.versions.some((v) => v.status === 'done');
  useSpaceToggle(clock.toggle, ready && clock.ready && replay.shown === undefined);
  // 换项目：停掉重播，播放头回到开头
  const { stop: stopReplay } = replay;
  const { pause, seek } = clock;
  useEffect(() => { stopReplay(); pause(); seek(0); }, [space?.id, stopReplay, pause, seek]);

  // 暂停（且有成片）时，输入框左下给出可插入的「@时间 卡片名」
  const shots = runs.view ? runs.stateOf(runs.view)?.storyboard.shots ?? [] : [];
  const pausedRef: TimeRef | undefined = useMemo(() => (ready && clock.ready && !clock.playing && replay.shown === undefined
    ? { sec: refSecond(clock.t, shots[shotIndexAt(shots, clock.t)]), label: cardName(shots[shotIndexAt(shots, clock.t)]) } : undefined), [ready, clock.ready, clock.playing, clock.t, shots, replay.shown]);
  const seekTo = useCallback((n: number, sec: number) => { if (runs.view !== n && n === 1) runs.setView(1); clock.seek(sec); }, [runs, clock]);

  return (
    <MotionConfig reducedMotion="user">
      <div className="app">
        <AnnouncementBar spent={liveSpent(space, runningCost)} />
        <div className="main">
          <SpacesRail spaces={wb.spaces} currentId={space?.id} onSelect={wb.selectSpace} onNew={wb.newSpace} />
          {space && options ? (
            <>
              <ChatFlow wb={wb} space={space} options={options} runs={runs} convo={convo} replay={replay} onSeek={seekTo} runningCost={runningCost}
                composer={<Composer ready={ready} convo={convo} pausedRef={pausedRef} onExport={() => runs.view && void runs.exportVersion(runs.view)} />} />
              <PreviewStage space={space} options={options} estimate={wb.estimate} totalSec={totalSec} runs={runs} clock={clock} replay={replay}
                onRef={convo.addRef} notify={wb.notify} />
            </>
          ) : (
            <div className="boot" role="status">
              {wb.loadError ? <><b>工作台没能启动</b><span>{wb.loadError}</span></> : <><span className="spin" /><span>正在连接本机服务 <It l>(127.0.0.1)</It></span></>}
            </div>
          )}
        </div>
      </div>
      <AnimatePresence>
        {wb.toast && (
          <motion.div className="toast" role="status" initial={{ opacity: 0, y: 12, x: '-50%' }} animate={{ opacity: 1, y: 0, x: '-50%' }} exit={{ opacity: 0, y: 8, x: '-50%' }} transition={SPRING}>
            {wb.toast}
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
