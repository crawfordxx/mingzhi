/** 素材来源抽屉：遮罩 + 面板；Esc 或点遮罩关闭 */
import { motion } from 'motion/react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useCredits } from '../useCredits';
import type { Notify } from '../useWorkbench';
import { CreditsPanel } from './CreditsPanel';

interface Props { spaceId: string; version: number; notify: Notify; refresh: (id: string) => Promise<void>; onClose: () => void }

export function CreditsDrawer({ spaceId, version, notify, refresh, onClose }: Props) {
  const { view, busy, mark, copy } = useCredits({ spaceId, version, notify, refresh });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // 挂到 body：对话流里的元素带入场变换，fixed 定位会被它限制住
  return createPortal(
    <>
      <motion.div className="cred-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} onClick={onClose} />
      <CreditsPanel version={version} view={view} busy={busy} onMark={(item, action) => void mark(item, action)} onCopy={copy} onClose={onClose} />
    </>,
    document.body,
  );
}
