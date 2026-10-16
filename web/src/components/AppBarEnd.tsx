/**
 * 公告条右端：有新版本时的克制胶囊（点开看说明 +「去下载」打开 Release 页面）与设置（检查更新开关、退出明知AI剪辑）。
 * 两个浮窗同一时间只开一个，点外面或按 Esc 关闭。
 * 焦点：浮窗打开（或切到退出确认）时移到第一个控件，关闭时回到打开它的按钮；退出后移到「已退出」卡，页面其余部分设为 inert。
 */
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Space } from '../api';
import { exitWarning } from '../lib/appbar';
import type { AppBarState } from '../useAppBar';
import { Ico, It, SOFT, SPRING, Tap } from '../ui';

type Open = 'update' | 'settings' | null;

/** 点外面或按 Esc 时关闭 */
function useDismiss(open: Open, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}

const FOCUSABLE = 'button:not(:disabled), a[href]';

/** 挂载（或 key 变化）时把焦点移到容器里的第一个控件 */
function useFocusFirst(ref: RefObject<HTMLElement>, key?: unknown) {
  useEffect(() => { ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus(); }, [ref, key]);
}

function Pop({ label, children, view }: { label: string; children: ReactNode; view?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusFirst(ref, view);
  return (
    <motion.div ref={ref} className="pop" role="dialog" aria-label={label} initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98 }} transition={{ duration: 0.16 }}>{children}</motion.div>
  );
}

function UpdatePop({ bar, onClose }: { bar: AppBarState; onClose: () => void }) {
  const u = bar.update!;
  return (
    <Pop label="新版本">
      <h4>明知AI剪辑 <It l>v{u.version}</It> 已发布</h4>
      <p className="pop-sub">当前 v{bar.version}。下载新的启动器，双击它就会换上新版本；项目、模型和设置都保留。</p>
      {u.notes && <pre className="pop-notes">{u.notes}</pre>}
      <div className="pop-acts">
        <Tap className="btn btn-g" onClick={onClose}>稍后</Tap>
        <a className="btn btn-k" href={u.url} target="_blank" rel="noreferrer noopener" onClick={onClose}>去下载 {Ico.ext}</a>
      </div>
    </Pop>
  );
}

function ConfirmExit({ spaces, bar, onCancel }: { spaces: Space[]; bar: AppBarState; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const warn = exitWarning(spaces);
  const go = async () => { setBusy(true); if (!(await bar.quit())) setBusy(false); };
  return (
    <>
      <h4>退出明知AI剪辑？</h4>
      <p className="pop-sub">工作台会关闭，项目和成片都留在这台电脑上。下次双击启动器就能接着用。</p>
      {warn && <p className="pop-warn" role="alert">{warn}</p>}
      <div className="pop-acts">
        <Tap className="btn btn-g" onClick={onCancel} disabled={busy}>取消</Tap>
        <Tap className={`btn ${warn ? 'btn-neg' : 'btn-k'}`} onClick={() => void go()} disabled={busy}>
          {busy ? <><span className="spin" />正在退出</> : warn ? '中断并退出' : '退出'}
        </Tap>
      </div>
    </>
  );
}

function SettingsPop({ spaces, bar }: { spaces: Space[]; bar: AppBarState }) {
  const [confirm, setConfirm] = useState(false);
  const on = bar.checkUpdates !== false;
  return (
    <Pop label={confirm ? '退出确认' : '设置'} view={confirm ? 'confirm' : 'settings'}>
      {confirm ? <ConfirmExit spaces={spaces} bar={bar} onCancel={() => setConfirm(false)} /> : (
        <>
          <h4>设置 <It l>(v{bar.version})</It></h4>
          <label className="pref">
            <span><b>检查更新</b><small>每天最多查一次 GitHub 上的新版本，只发匿名请求，不收集任何数据。</small></span>
            <button type="button" role="switch" aria-checked={on} className={`sw${on ? ' on' : ''}`} disabled={bar.checkUpdates === undefined}
              onClick={() => void bar.toggleUpdates(!on)}><i /></button>
          </label>
          <button type="button" className="pref-quit" onClick={() => setConfirm(true)}>退出明知AI剪辑</button>
        </>
      )}
    </Pop>
  );
}

/** 浮窗关闭后，焦点若还在浮窗里（已被移除，落到 body）就回到打开它的按钮 */
function useReturnFocus(open: Open, pill: RefObject<HTMLButtonElement>, gear: RefObject<HTMLButtonElement>) {
  const prev = useRef<Open>(null);
  useEffect(() => {
    const was = prev.current;
    prev.current = open;
    if (!was || open) return;
    const active = document.activeElement;
    if (!active || active === document.body || active.closest('.bar-end')) (was === 'update' ? pill : gear).current?.focus();
  }, [open, pill, gear]);
}

export function AppBarEnd({ spaces, bar }: { spaces: Space[]; bar: AppBarState }) {
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const ref = useDismiss(open, close);
  const pillRef = useRef<HTMLButtonElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  useReturnFocus(open, pillRef, gearRef);
  const toggle = (which: Open) => setOpen((cur) => (cur === which ? null : which));
  return (
    <div className="bar-end" ref={ref}>
      <AnimatePresence>
        {bar.update && (
          <motion.button key="pill" ref={pillRef} type="button" className={`pill-new${open === 'update' ? ' on' : ''}`}
            aria-haspopup="dialog" aria-expanded={open === 'update'}
            initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={SOFT} whileTap={{ scale: 0.97 }}
            onClick={() => toggle('update')}>
            <i aria-hidden="true" />有新版本 <It l>v{bar.update.version}</It>
          </motion.button>
        )}
      </AnimatePresence>
      <motion.button ref={gearRef} type="button" className={`gear${open === 'settings' ? ' on' : ''}`} aria-label="设置" title="设置"
        aria-haspopup="dialog" aria-expanded={open === 'settings'} whileTap={{ scale: 0.97 }} transition={SPRING} onClick={() => toggle('settings')}>
        {Ico.gear}
      </motion.button>
      <AnimatePresence>
        {open === 'update' && bar.update && <UpdatePop key="u" bar={bar} onClose={close} />}
        {open === 'settings' && <SettingsPop key="s" spaces={spaces} bar={bar} />}
      </AnimatePresence>
    </div>
  );
}

/** 退出后整页换成这张卡：服务已经停了，页面其余部分设为 inert（不能再 Tab 到），焦点移到卡片 */
export function Exited() {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const app = document.querySelector('.app');
    app?.setAttribute('inert', '');
    card.current?.focus();
    return () => app?.removeAttribute('inert');
  }, []);
  return (
    <motion.div className="exited" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
      <motion.div ref={card} tabIndex={-1} className="card exited-card" initial={{ y: 10, scale: 0.98 }} animate={{ y: 0, scale: 1 }} transition={SOFT}>
        <b>明知AI剪辑 已退出</b>
        <span>项目和成片都还在这台电脑上。现在可以关掉这个标签页；那个终端（命令行）窗口如果还开着，也可以直接关掉。下次双击启动器就能接着用。</span>
      </motion.div>
    </motion.div>
  );
}
