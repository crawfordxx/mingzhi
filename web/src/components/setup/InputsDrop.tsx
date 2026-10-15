/** 口播：拖入或选择（多段），逐段显示上传进度与本地读出的时长/分辨率 */
import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState, type DragEvent } from 'react';
import type { Upload } from '../../useWorkbench';
import { fmtDuration, fmtSize } from '../../lib/media';
import { Ico, It, SOFT, SPRING } from '../../ui';

interface Props { inputs: string[]; uploads: Upload[]; onFiles: (files: File[]) => void; onDismiss: (key: string) => void }

interface Row { key: string; name: string; meta: string; progress?: number; state: Upload['state']; error?: string }

function rowsOf(inputs: string[], uploads: Upload[]): Row[] {
  const describe = (u?: Upload) => (!u ? '已上传' : u.meta ? `${fmtDuration(u.meta.duration)} · ${u.meta.width}×${u.meta.height} · ${fmtSize(u.size)}` : fmtSize(u.size));
  const pending = uploads.filter((u) => u.state !== 'done' || !inputs.includes(u.name));
  const done = inputs.map((name, i) => {
    const u = uploads.find((x) => x.name === name && x.state === 'done');
    return { key: `in-${i}-${name}`, name, meta: describe(u), state: 'done' as const };
  });
  return [...done, ...pending.map((u) => ({ key: u.key, name: u.name, meta: describe(u), progress: u.progress, state: u.state, error: u.error }))];
}

function InputRow({ r, i, onDismiss }: { r: Row; i: number; onDismiss: (key: string) => void }) {
  return (
    <motion.div layout className={`in-row ${r.state}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={SOFT}>
      <It className="in-n">{String(i + 1).padStart(2, '0')}</It>
      <span className="in-ico">{Ico.film}</span>
      <span className="in-txt">
        <span className="in-name" title={r.name}>{r.name}</span>
        {r.state === 'uploading' ? (
          <span className="in-bar"><motion.i initial={{ scaleX: 0 }} animate={{ scaleX: r.progress ?? 0 }} transition={SOFT} /></span>
        ) : (
          <span className={`in-meta${r.state === 'error' ? ' bad' : ''}`}>{r.state === 'error' ? r.error : r.meta}</span>
        )}
      </span>
      <span className="in-state">
        {r.state === 'uploading' && <span className="in-pct">{Math.round((r.progress ?? 0) * 100)}%</span>}
        {r.state === 'done' && <motion.span className="in-ok" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={SPRING}>{Ico.check}</motion.span>}
        {r.state === 'error' && <button className="in-x" onClick={() => onDismiss(r.key)} aria-label="移除这条">{Ico.close}</button>}
      </span>
    </motion.div>
  );
}

/** 拖入区：dragenter/leave 计数防闪烁，拖入时描边发光、图标上浮 */
function DropZone({ empty, onFiles }: { empty: boolean; onFiles: (files: File[]) => void }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const drag = {
    onDragEnter: (e: DragEvent) => { e.preventDefault(); depth.current += 1; setOver(true); },
    onDragOver: (e: DragEvent) => e.preventDefault(),
    onDragLeave: () => { depth.current -= 1; if (depth.current <= 0) setOver(false); },
    onDrop: (e: DragEvent) => {
      e.preventDefault(); depth.current = 0; setOver(false);
      const files = [...e.dataTransfer.files];
      if (files.length) onFiles(files);
    },
  };
  return (
    <motion.label layout className={`drop${empty ? ' big' : ''}${over ? ' over' : ''}`} {...drag} transition={SOFT} animate={{ scale: over ? 1.012 : 1 }}>
      <input type="file" multiple accept="video/*,audio/*,.mov,.mp4,.m4v,.mkv,.m4a,.mp3,.wav" className="sr"
        onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; if (fs.length) onFiles(fs); }} />
      <motion.span className="drop-ico" animate={{ y: over ? -3 : 0 }} transition={SPRING}>{empty ? Ico.upload : Ico.plus}</motion.span>
      {empty ? (
        <span className="drop-txt">
          <b>{over ? '松手，就放这儿' : '把口播拖到这里'}</b>
          <span>或 <u>选择文件</u> · 可以一次放多段，我会按语义排好顺序 <It>(mov · mp4 · m4a)</It></span>
        </span>
      ) : (
        <span className="drop-txt row"><b>{over ? '松手添加' : '再加一段'}</b><span>拖入或点选</span></span>
      )}
    </motion.label>
  );
}

export function InputsDrop({ inputs, uploads, onFiles, onDismiss }: Props) {
  const rows = rowsOf(inputs, uploads);
  return (
    <div className="inputs">
      <AnimatePresence initial={false}>
        {rows.map((r, i) => <InputRow key={r.key} r={r} i={i} onDismiss={onDismiss} />)}
      </AnimatePresence>
      <DropZone empty={rows.length === 0} onFiles={onFiles} />
    </div>
  );
}
