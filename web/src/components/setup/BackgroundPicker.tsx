/** 背景：10 个预设缩略图 + 上传 + 一句话生成；选中环用 layoutId 在格子间滑动 */
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackgroundOption, BackgroundSpec } from '../../api';
import { Ico, It, SOFT, SPRING } from '../../ui';

interface Props {
  options: BackgroundOption[];
  value?: BackgroundSpec;
  uploading?: { name: string; progress: number };
  onChange: (bg: BackgroundSpec | undefined) => void;
  onUpload: (file: File) => void;
}

const Ring = () => <motion.span layoutId="bg-ring" className="sel-ring" transition={SPRING} />;
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** 一句话生成背景：回车或失焦时明确提交一次（服务端要求 2–300 字），同一句不重复提交 */
function PromptRow({ saved, onCommit }: { saved: string; onCommit: (prompt: string) => void }) {
  const [draft, setDraft] = useState(saved);
  const inputRef = useRef<HTMLInputElement>(null);
  const committed = useRef(saved);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const commit = () => {
    const p = draft.trim();
    if (p.length < 2 || p === committed.current) return;
    committed.current = p;
    onCommit(p);
  };
  const pending = draft.trim().length >= 2 && draft.trim() !== saved;
  return (
    <motion.div className="bg-prompt" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SOFT}>
      <div className="bg-prompt-in">
        <span className="bgp-ico">{Ico.spark}</span>
        <input ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); inputRef.current?.blur(); } }}
          placeholder="描述想要的背景，例如「傍晚靠窗的木质书房，暖光」" maxLength={300} aria-label="一句话描述背景" />
        <span className={`bgp-state${pending ? '' : ' ok'}`}>{pending ? '回车确认' : saved ? <>{Ico.check}已用这句</> : null}</span>
        <It className="bgp-cost">(约 ¥0.20)</It>
      </div>
    </motion.div>
  );
}

export function BackgroundPicker({ options, value, uploading, onChange, onUpload }: Props) {
  const [writing, setWriting] = useState(value?.kind === 'prompt');
  const fileRef = useRef<HTMLInputElement>(null);
  const tile = (key: string, on: boolean, click: () => void, face: ReactNode, name: string, label = name) => (
    <motion.button key={key} type="button" className={`bgt${on ? ' on' : ''}`} onClick={click} aria-pressed={on} aria-label={label}
      whileHover={{ y: -2 }} whileTap={{ scale: 0.96 }} transition={SPRING}>
      <span className="bgt-im">{face}{on && <Ring />}</span>
      <span className="bgt-nm">{name}</span>
    </motion.button>
  );

  return (
    <div className="bgpick">
      <div className="bg-grid">
        {options.map((o) => tile(o.id, value?.kind === 'preset' && value.id === o.id, () => { setWriting(false); onChange({ kind: 'preset', id: o.id }); },
          <img src={o.thumb} alt="" loading="lazy" draggable={false} />, o.name))}
        {tile('upload', value?.kind === 'file', () => fileRef.current?.click(),
          <span className="bgt-act">{uploading ? <span className="bgt-pct">{Math.round(uploading.progress * 100)}%</span> : Ico.image}</span>,
          value?.kind === 'file' ? baseName(value.path) : '上传图片', '上传背景图片')}
        {tile('prompt', value?.kind === 'prompt' || writing, () => setWriting(true),
          <span className="bgt-act">{Ico.spark}</span>, '一句话生成')}
      </div>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onUpload(f); }} />
      <AnimatePresence initial={false}>
        {writing && <PromptRow saved={value?.kind === 'prompt' ? value.prompt : ''} onCommit={(prompt) => onChange({ kind: 'prompt', prompt })} />}
      </AnimatePresence>
    </div>
  );
}
