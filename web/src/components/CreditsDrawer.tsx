/** 素材来源抽屉：遮罩 + 面板；打开时焦点移入面板并锁在里面，Esc、点遮罩或关闭钮关闭，关闭后焦点回到触发按钮 */
import { motion } from 'motion/react';
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { nextFocus } from '../lib/focusTrap';
import { useCredits } from '../useCredits';
import type { Notify } from '../useWorkbench';
import { CreditsPanel } from './CreditsPanel';

interface Props { /** 打开抽屉的按钮：关闭后焦点还给它（Safari 点按钮不聚焦，不能靠 activeElement） */ opener: HTMLElement | null; spaceId: string; version: number; notify: Notify; refresh: (id: string) => Promise<void>; onClose: () => void }

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** 打开时把焦点移进面板，关闭时还给打开前聚焦的元素（「素材来源」按钮） */
function useFocusScope(panel: RefObject<HTMLElement>, opener: HTMLElement | null) {
  useEffect(() => {
    panel.current?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, [panel, opener]);
}

export function CreditsDrawer({ opener, spaceId, version, notify, refresh, onClose }: Props) {
  const { view, busy, submitted, mark, copy } = useCredits({ spaceId, version, notify, refresh });
  const panel = useRef<HTMLElement>(null);
  useFocusScope(panel, opener);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Tab 只在面板里循环，不会走到被遮罩盖住的页面
  const trap = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const target = nextFocus(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
    if (target !== undefined) { e.preventDefault(); items[target].focus(); }
  };

  // 挂到 body：对话流里的元素带入场变换，fixed 定位会被它限制住
  return createPortal(
    <div onKeyDown={trap}>
      <motion.div className="cred-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} onClick={onClose} />
      <CreditsPanel version={version} view={view} busy={busy} submitted={submitted} panelRef={panel} onMark={(item, action) => void mark(item, action)} onCopy={copy} onClose={onClose} />
    </div>,
    document.body,
  );
}
