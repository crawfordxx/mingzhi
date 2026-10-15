/** 共用小件：动效常量、图标、红黄绿、按压按钮 */
import { motion, useReducedMotion, useSpring, useTransform, type HTMLMotionProps } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';

/** 按压/选中用硬一点的弹簧，展开/入场用软弹簧（与 G1 原稿一致） */
export const SPRING = { type: 'spring', stiffness: 420, damping: 34 } as const;
export const SOFT = { type: 'spring', stiffness: 240, damping: 32 } as const;
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const Ico = {
  up: <svg viewBox="0 0 16 16" {...stroke} strokeWidth={1.8}><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>,
  down: <svg viewBox="0 0 16 16" {...stroke}><path d="M8 2.5v8M4 7l4 4 4-4M3 13.5h10" /></svg>,
  ext: <svg viewBox="0 0 16 16" {...stroke}><path d="M5 11 11 5M6 5h5v5" /></svg>,
  play: <svg viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7.5-4.5z" /></svg>,
  pause: <svg viewBox="0 0 12 12" fill="currentColor"><rect x="2.5" y="1.5" width="2.5" height="9" rx=".6" /><rect x="7" y="1.5" width="2.5" height="9" rx=".6" /></svg>,
  replay: <svg viewBox="0 0 16 16" {...stroke}><path d="M2.5 8a5.5 5.5 0 1 0 1.7-4" /><path d="M2.5 2.5v3.5H6" /></svg>,
  undo: <svg viewBox="0 0 16 16" {...stroke}><path d="M5.5 4 2.5 7l3 3" /><path d="M2.5 7h7a4 4 0 0 1 0 8H8" /></svg>,
  plus: <svg viewBox="0 0 16 16" {...stroke}><path d="M8 3v10M3 8h10" /></svg>,
  close: <svg viewBox="0 0 16 16" {...stroke}><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" /></svg>,
  check: <svg viewBox="0 0 16 16" {...stroke} strokeWidth={2}><path d="m3.5 8.5 3 3 6-7" /></svg>,
  upload: <svg viewBox="0 0 24 24" {...stroke} strokeWidth={1.5}><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" /><path d="M4 14.5v3A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5v-3" /></svg>,
  image: <svg viewBox="0 0 16 16" {...stroke}><rect x="2.5" y="3" width="11" height="10" rx="2" /><path d="m3 11.5 3-3 2.5 2.5L10.5 9l2.5 2.5" /><circle cx="10.5" cy="6" r="1" /></svg>,
  spark: <svg viewBox="0 0 16 16" {...stroke}><path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8l4.2-1.3z" /></svg>,
  film: <svg viewBox="0 0 16 16" {...stroke}><rect x="3" y="2" width="10" height="12" rx="2" /><path d="M6 6.5v3l3-1.5z" fill="currentColor" stroke="none" /></svg>,
  key: <svg viewBox="0 0 16 16" {...stroke}><circle cx="5.5" cy="10.5" r="3" /><path d="m7.6 8.4 5.4-5.4M11 5l1.6 1.6M9.5 6.5l1.2 1.2" /></svg>,
  chevL: <svg viewBox="0 0 16 16" {...stroke} strokeWidth={1.8}><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>,
  chevR: <svg viewBox="0 0 16 16" {...stroke} strokeWidth={1.8}><path d="M6 3.5 10.5 8 6 12.5" /></svg>,
  lock: <svg viewBox="0 0 16 16" {...stroke}><rect x="3.5" y="7" width="9" height="6.5" rx="1.6" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>,
};

export const Lights = ({ size }: { size?: number }) => (
  <span className="lights" aria-hidden="true">
    {[0, 1, 2].map((i) => <i key={i} style={size ? { width: size, height: size } : undefined} />)}
  </span>
);

/** 带按压回弹的按钮；禁用时不缩放 */
export function Tap({ children, disabled, ...rest }: HTMLMotionProps<'button'> & { children?: ReactNode }) {
  return (
    <motion.button whileTap={disabled ? undefined : { scale: 0.97 }} transition={SPRING} disabled={disabled} {...rest}>
      {children}
    </motion.button>
  );
}

/** 斜体衬线小注 */
export const It = ({ children, l, className = '' }: { children: ReactNode; l?: boolean; className?: string }) => (
  <span className={`it${l ? ' l' : ''} ${className}`.trim()}>{children}</span>
);

/** 数字滚动（Revolut 式计数）：值变了就用弹簧滚过去；减弱动效时直接跳到目标值 */
export function Num({ value, format, className }: { value: number; format: (v: number) => string; className?: string }) {
  const reduce = useReducedMotion();
  const spring = useSpring(value, { stiffness: 140, damping: 24, mass: 0.6 });
  useEffect(() => { if (reduce) spring.jump(value); else spring.set(value); }, [value, reduce, spring]);
  const text = useTransform(spring, format);
  return <motion.span className={className}>{text}</motion.span>;
}

/** 每隔 ms 刷新一次的当前时间（用来显示「已用 0:12」）；active=false 时不走 */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [active, ms]);
  return now;
}
