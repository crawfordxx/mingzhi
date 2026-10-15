/** 顶部公告条（ego 的 --brand-1 条 + 黑色小胶囊）：开源声明 + 本项目已花费 + 去可想 AI 查看余额 */
import { motion } from 'motion/react';
import { yuan } from '../lib/media';
import { Ico, It, SOFT } from '../ui';

export const KEXIANG_URL = 'https://kexiangai.com';

export function AnnouncementBar({ spent }: { spent: number }) {
  return (
    <motion.div className="bar" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={SOFT}>
      <span className="bar-msg">
        明知AI剪辑 <It>(MIT)</It> 开源免费，识别在本机完成
        <span className="bar-sep" aria-hidden="true">·</span>
        本项目已花 <motion.b key={spent.toFixed(2)} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={SOFT}>{yuan(spent)}</motion.b>
      </span>
      <motion.a className="btn btn-k" href={KEXIANG_URL} target="_blank" rel="noreferrer" whileTap={{ scale: 0.97 }}>
        去可想 AI 查看余额 {Ico.ext}
      </motion.a>
    </motion.div>
  );
}
