/** 输入框：出片前处于等待态（对话修改在下一个任务接入），保留 G1 的胶囊快捷语与 @时间 提示 */
import { motion } from 'motion/react';
import { useState } from 'react';
import { Ico, It, SPRING, Tap } from '../ui';

const CHIPS = ['节奏再快一点', '换一张 B-roll', '字幕换成得意', '导出'];

export function Composer({ ready }: { ready: boolean }) {
  const [focus, setFocus] = useState(false);
  const [draft, setDraft] = useState('');
  return (
    <div className="composer">
      <div className={`box${focus ? ' focus' : ''}${ready ? '' : ' idle'}`}>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          disabled={!ready} rows={2} aria-label="一句话修改"
          placeholder={ready ? '说一句话修改，例如「这张换成对比图」' : '出片后，在这里用一句话修改，例如「节奏再快一点」'} />
        <div className="box-f">
          {CHIPS.map((c) => (
            <motion.button key={c} type="button" className="chip" disabled={!ready} onClick={() => setDraft(c)}
              whileHover={ready ? { y: -1 } : undefined} whileTap={ready ? { scale: 0.96 } : undefined} transition={SPRING}>{c}</motion.button>
          ))}
          <Tap className="send" aria-label="发送" disabled={!ready || !draft.trim()}>{Ico.up}</Tap>
        </div>
      </div>
      <div className="foot">
        <span>{ready ? '点预览画面，可插入 @时间' : '对话修改会在 v1 出片后开放'}</span>
        <span>本轮预估 <It l>(—)</It></span>
      </div>
    </div>
  );
}
