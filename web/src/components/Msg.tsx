/** 对话流的条目外壳：进入视口时上浮淡入（motion whileInView，root = 对话流） */
import { motion } from 'motion/react';
import type { ReactNode, RefObject } from 'react';
import { SOFT } from '../ui';

export function Msg({ root, children, delay = 0, user, id }: { root: RefObject<HTMLDivElement>; children: ReactNode; delay?: number; user?: boolean; id?: string }) {
  return (
    <motion.div id={id} className={`msg${user ? ' user' : ''}`} layout="position" initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ root, once: true, amount: 0.1 }} transition={{ ...SOFT, delay }}>
      {children}
    </motion.div>
  );
}

export const Who = ({ children }: { children: ReactNode }) => <div className="who"><i>明</i>{children}</div>;
