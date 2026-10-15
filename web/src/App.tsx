/** 工作台外壳：公告条 / Spaces 栏 / 对话流 / 大预览 */
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useEffect } from 'react';
import { spentOf } from './api';
import { AnnouncementBar } from './components/AnnouncementBar';
import { ChatFlow } from './components/ChatFlow';
import { Composer } from './components/Composer';
import { PreviewStage } from './components/PreviewStage';
import { SpacesRail } from './components/SpacesRail';
import { useWorkbench } from './useWorkbench';
import { It, SPRING } from './ui';

export function App() {
  const wb = useWorkbench();
  // 文件拖到拖入区以外时，阻止浏览器直接打开视频、把工作台换掉
  useEffect(() => {
    const stop = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, []);
  const { space, options } = wb;
  const totalSec = wb.estimate?.durationSec ?? 0;
  const ready = !!space?.versions.some((v) => v.status === 'done');

  return (
    <MotionConfig reducedMotion="user">
      <div className="app">
        <AnnouncementBar spent={spentOf(space)} />
        <div className="main">
          <SpacesRail spaces={wb.spaces} currentId={space?.id} onSelect={wb.selectSpace} onNew={wb.newSpace} />
          {space && options ? (
            <>
              <ChatFlow wb={wb} space={space} options={options} composer={<Composer ready={ready} />} />
              <PreviewStage space={space} options={options} estimate={wb.estimate} totalSec={totalSec} />
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
