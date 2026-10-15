/**
 * 输入框：@时间 引用标签（可移除）+ 一句话 + 快捷语胶囊 + 发送。
 * 预览暂停时左下出现「插入 @mm:ss 卡片名」；点预览画面时，引用胶囊从点击处飞进标签区（G1 的飞入动效）。
 * 发出去的消息里每个引用后面固定带一个空格（见 lib/shots.composeMessage）。
 */
import { AnimatePresence, motion } from 'motion/react';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ShotState } from '../api';
import { cardName, refSecond, refText, shotIndexAt, type TimeRef } from '../lib/shots';
import { useClock, type Clock } from '../usePlayback';
import type { Conversation, Flying } from '../useConversation';
import { Ico, It, SPRING, Tap } from '../ui';
import { InsertRef, TimeRefChip } from './TimeRefChip';

const CHIPS = ['节奏再快一点', '换一张 B-roll', '字幕换成得意', '导出'];

/** 飞行中的引用胶囊：从点击处飞到标签区末尾，落地后才真正加进标签 */
function Flyer({ f, target, onLand }: { f: Flying; target: RefObject<HTMLDivElement>; onLand: () => void }) {
  const [to, setTo] = useState<{ x: number; y: number }>();
  useLayoutEffect(() => {
    const r = target.current?.getBoundingClientRect();
    const last = target.current?.lastElementChild?.getBoundingClientRect();
    if (r) setTo({ x: last && last.width ? last.right + 6 : r.left + 8, y: (last && last.width ? last.top : r.top + 4) });
  }, [f.key, target]);
  if (!to) return null;
  return (
    <motion.span className="hl ref flyer" initial={{ x: f.x - 40, y: f.y - 12, scale: 1.25, opacity: 0.9 }} animate={{ x: to.x, y: to.y, scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 170, damping: 21 }} onAnimationComplete={onLand}>{refText(f.ref)}</motion.span>
  );
}

interface Props {
  ready: boolean;
  convo: Conversation;
  /** 播放时钟与当前版本的分镜：暂停时据此给出可插入的引用 */
  clock: Clock;
  shots?: ShotState[];
  /** 重播剪辑过程时不给插入 */
  locked: boolean;
  onExport: () => void;
}

/** 暂停（且有成片）时的「@时间 卡片名」；只订阅「暂停时的播放头」，播放中不会重渲 */
function usePausedRef(clock: Clock, shots: ShotState[] | undefined, off: boolean): TimeRef | undefined {
  const sec = useClock(clock, (s) => (!s.playing && s.duration > 0 ? s.t : -1));
  if (off || sec < 0 || !shots) return undefined;
  const shot = shots[shotIndexAt(shots, sec)];
  return { sec: refSecond(sec, shot), label: cardName(shot) };
}

export function Composer({ ready, convo, clock, shots, locked, onExport }: Props) {
  const pausedRef = usePausedRef(clock, shots, !ready || locked);
  const [focus, setFocus] = useState(false);
  const tags = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const { draft, setDraft, refs } = convo;
  const canSend = ready && (draft.trim().length > 0 || refs.length > 0);
  const chip = (c: string) => { if (c === '导出') onExport(); else { setDraft(c); area.current?.focus(); } };
  const insert = (r: TimeRef) => { convo.addRef(r); area.current?.focus(); };
  return (
    <div className="composer">
      <div className={`box${focus ? ' focus' : ''}${ready ? '' : ' idle'}`}>
        <div className="tags" ref={tags}>
          <AnimatePresence initial={false}>
            {refs.map((r, i) => (
              <motion.span layout key={`${r.sec}-${r.label}`} initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.7 }} transition={SPRING}>
                <TimeRefChip r={r} onRemove={() => convo.removeRef(i)} />
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
        <textarea ref={area} value={draft} onChange={(e) => setDraft(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend) void convo.send(); } }}
          disabled={!ready} rows={2} aria-label="一句话修改"
          placeholder={ready ? '说一句话修改，例如「这张换成对比图」' : '出片后，在这里用一句话修改，例如「节奏再快一点」'} />
        <div className="box-f">
          {CHIPS.map((c) => (
            <motion.button key={c} type="button" className="chip" disabled={!ready} onClick={() => chip(c)}
              whileHover={ready ? { y: -1 } : undefined} whileTap={ready ? { scale: 0.96 } : undefined} transition={SPRING}>{c}</motion.button>
          ))}
          <Tap className="send" aria-label="发送" disabled={!canSend} onClick={() => void convo.send()}>{Ico.up}</Tap>
        </div>
      </div>
      <div className="foot">
        <span className="foot-l">{ready && pausedRef ? <InsertRef r={pausedRef} onInsert={insert} /> : ready ? '点预览画面，可插入 @时间' : '对话修改会在首版出片后开放'}</span>
        <span>本轮预估 <It l>({canSend ? '规划约 ¥0.01' : '—'})</It></span>
      </div>
      {convo.flying && <Flyer key={convo.flying.key} f={convo.flying} target={tags} onLand={convo.land} />}
    </div>
  );
}
