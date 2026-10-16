/** 工作台外壳：公告条 / Spaces 栏 / 对话流 / 大预览 */
import { MotionConfig } from 'motion/react';
import { useCallback, useEffect, useRef } from 'react';
import { spentOf, type Space } from './api';
import { AnnouncementBar } from './components/AnnouncementBar';
import { ChatFlow } from './components/ChatFlow';
import { Composer } from './components/Composer';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PreviewStage } from './components/PreviewStage';
import { Toast } from './components/Toast';
import { SpacesRail } from './components/SpacesRail';
import { reduceLive } from './lib/liveModel';
import { liveVersionOf } from './lib/versions';
import { useReplay, type Replay } from './live';
import { useConversation } from './useConversation';
import { useClock, usePlayback, type Clock } from './usePlayback';
import { useRuns } from './useRuns';
import { useWorkbench } from './useWorkbench';
import { It } from './ui';

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

/** 换项目：停掉重播、暂停、播放头回到开头；切版本或开关对比：先暂停（新挂上的视频本来就是暂停的） */
function usePlaybackResets(clock: Clock, replay: Replay, spaceId: string | undefined, view: number | undefined, compare: boolean) {
  const { stop } = replay;
  useEffect(() => { stop(); clock.pause(); clock.seek(0); }, [spaceId, stop, clock]);
  useEffect(() => { clock.pause(); }, [view, compare, clock]);
}

const Boot = ({ error }: { error?: string }) => (
  <div className="boot" role="status">
    {error ? <><b>工作台没能启动</b><span>{error}</span></> : <><span className="spin" /><span>正在连接本机服务 <It l>(127.0.0.1)</It></span></>}
  </div>
);

export function App() {
  const wb = useWorkbench();
  useBlockFileDrop();
  const { space, options } = wb;
  const runs = useRuns({ space, putSpace: wb.putSpace, notify: wb.notify });
  const clock = usePlayback();
  // 剪辑直播与重播跟随首版（首版失败重开后不一定是 v1）
  const liveN = space ? liveVersionOf(space) : undefined;
  const replay = useReplay(runs.eventsOf(liveN ?? 0));
  const convo = useConversation({ space, base: runs.view, busy: runs.active !== undefined, notify: wb.notify, refresh: runs.refresh });
  const runningCost = runs.active ? reduceLive(runs.eventsOf(runs.active)).cost?.total ?? 0 : 0;
  const ready = !!space?.versions.some((v) => v.status === 'done');
  const hasVideo = useClock(clock, (st) => st.duration > 0);
  useSpaceToggle(clock.toggle, ready && hasVideo && replay.shown === undefined);
  usePlaybackResets(clock, replay, space?.id, runs.view, runs.compare);
  const shots = runs.view ? runs.stateOf(runs.view)?.storyboard.shots : undefined;
  const seekTo = useCallback((n: number, sec: number) => {
    if (runs.view !== n && n === liveN) runs.setView(n);
    clock.seek(sec);
  }, [runs, clock, liveN]);
  const onExport = () => runs.view && void runs.exportVersion(runs.view);
  const composer = <Composer ready={ready} convo={convo} clock={clock} shots={shots} locked={replay.shown !== undefined} onExport={onExport} />;
  return (
    <MotionConfig reducedMotion="user">
      <div className="app">
        <AnnouncementBar spent={liveSpent(space, runningCost)} fake={!!wb.status?.fake} />
        <div className="main">
          <SpacesRail spaces={wb.spaces} currentId={space?.id} onSelect={wb.selectSpace} onNew={wb.newSpace} />
          {space && options ? (
            <ErrorBoundary key={space.id}>
              <ChatFlow wb={wb} space={space} options={options} runs={runs} convo={convo} replay={replay} onSeek={seekTo}
                runningCost={runningCost} liveN={liveN} composer={composer} />
              <PreviewStage space={space} options={options} estimate={wb.estimate} totalSec={wb.estimate?.durationSec ?? 0} runs={runs}
                clock={clock} replay={replay} onRef={convo.addRef} notify={wb.notify} liveN={liveN} />
            </ErrorBoundary>
          ) : <Boot error={wb.loadError} />}
        </div>
      </div>
      <Toast toast={wb.toast} onDismiss={wb.dismissToast} />
    </MotionConfig>
  );
}
