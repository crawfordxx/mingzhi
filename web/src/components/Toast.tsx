/** 底部提示条：一句话 + 可选的一个按钮（导出后「复制署名文本」） */
import { AnimatePresence, motion } from 'motion/react';
import type { ToastState } from '../useWorkbench';
import { SPRING } from '../ui';

export function Toast({ toast, onDismiss }: { toast?: ToastState; onDismiss: () => void }) {
  return (
    <AnimatePresence>
      {toast && (
        <motion.div key={toast.text} className={`toast${toast.action ? ' has-act' : ''}`} role="status" initial={{ opacity: 0, y: 12, x: '-50%' }}
          animate={{ opacity: 1, y: 0, x: '-50%' }} exit={{ opacity: 0, y: 8, x: '-50%' }} transition={SPRING}>
          <span>{toast.text}</span>
          {toast.action && (
            <button type="button" className="toast-act" onClick={() => { toast.action?.run(); onDismiss(); }}>{toast.action.label}</button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
