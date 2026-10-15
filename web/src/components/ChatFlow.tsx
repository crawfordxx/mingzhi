/** 左侧对话流：标题 + 欢迎语 + key 卡 + 设置卡；开始出片后在这里接剪辑直播（下一个任务） */
import { AnimatePresence, motion, useScroll, useSpring, useTransform } from 'motion/react';
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { spentOf, type Options, type Space } from '../api';
import { yuan } from '../lib/media';
import type { Workbench } from '../useWorkbench';
import { It, Lights, SOFT } from '../ui';
import { KeyCard } from './KeyCard';
import { blockerOf, SetupCard } from './SetupCard';
import { BudgetFooter } from './setup/BudgetFooter';

function Msg({ root, children, delay = 0 }: { root: RefObject<HTMLDivElement>; children: ReactNode; delay?: number }) {
  return (
    <motion.div className="msg" layout="position" initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ root, once: true, amount: 0.1 }} transition={{ ...SOFT, delay }}>
      {children}
    </motion.div>
  );
}
const Who = ({ children }: { children: ReactNode }) => <div className="who"><i>明</i>{children}</div>;

function subtitle(space: Space): string {
  const n = space.inputs.length;
  return `${n ? `${n} 段口播` : '还没有口播'} · ${space.versions.length ? `${space.versions.length} 个版本` : '草稿'} · 已花 ${yuan(spentOf(space))} / 上限 ¥${space.settings.budgetYuan}`;
}

/** 标题里的「第 N 期」用斜体衬线点缀数字 */
function Title({ text }: { text: string }) {
  const m = text.match(/^(.*?)(第\s*\d+\s*期)(.*)$/);
  if (!m) return <h1>{text}</h1>;
  const name = `${m[1]}${m[3]}`.replace(/^[\s·]+|[\s·]+$/g, '') || '新的一期';
  return <h1>{name} <It l className="h1-it">({m[2]})</It></h1>;
}

/** 标题栏：随对话流滚动浮出阴影，底边一条细进度线（motion useScroll + useSpring） */
function ChatHeader({ space, stream }: { space: Space; stream: RefObject<HTMLDivElement> }) {
  const { scrollY, scrollYProgress } = useScroll({ container: stream, layoutEffect: false });
  const shadow = useTransform(scrollY, [0, 24], ['0 1px 0 rgba(0,0,0,0), 0 10px 24px -14px rgba(0,0,0,0)', '0 1px 0 rgba(0,0,0,.06), 0 10px 24px -14px rgba(0,0,0,.3)']);
  const progress = useSpring(scrollYProgress, { stiffness: 140, damping: 30 });
  return (
    <motion.header className="chat-head" style={{ boxShadow: shadow }}>
      <div>
        <Title text={space.title} />
        <div className="sub">{subtitle(space)}</div>
      </div>
      <motion.i className="chat-prog" style={{ scaleX: progress }} aria-hidden="true" />
    </motion.header>
  );
}

/** 开始出片后的占位：剪辑直播（SSE 逐行）在下一个任务接入 */
const LivePending = ({ space }: { space: Space }) => (
  <>
    <Who>明知 · 剪辑中</Who>
    <p className="say">收到，开始剪 <It l>v1</It>。转录、剪口误、分镜和自检会在这里逐行直播，完成后右侧出成片。</p>
    <div className="live-pending">
      <div className="titlebar"><Lights /><span className="tt">剪辑直播 — {space.title}</span></div>
      <div className="lp-body"><span className="spin" />排队中，马上开始转录<span className="lp-track"><i /></span></div>
    </div>
  </>
);

/** 底部停靠区：出片前是设置卡底栏（预算 + 预估 + 开始出片），开始后换成输入框 */
function Dock({ wb, space, composer, keyReady }: { wb: Workbench; space: Space; composer: ReactNode; keyReady: boolean }) {
  const started = space.versions.length > 0;
  return (
    <AnimatePresence mode="wait" initial={false}>
      {started ? (
        <motion.div key="composer" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={SOFT}>{composer}</motion.div>
      ) : (
        <motion.div key="dock" className="composer" exit={{ opacity: 0, y: 8 }} transition={SOFT}>
          <BudgetFooter budget={space.settings.budgetYuan} estimate={wb.estimate} estimating={wb.estimating} blocker={blockerOf(wb, space, keyReady)}
            starting={wb.starting} onBudget={(v) => wb.updateSettings({ budgetYuan: v })} onStart={wb.start} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface Props { wb: Workbench; space: Space; options: Options; composer: ReactNode }

export function ChatFlow({ wb, space, options, composer }: Props) {
  const stream = useRef<HTMLDivElement>(null);
  const [showKey] = useState(() => !wb.status?.keyConfigured);
  return (
    <section className="chat" aria-label="对话">
      <ChatHeader space={space} stream={stream} />
      <div className="stream" ref={stream}>
        <AnimatePresence mode="wait">
          <motion.div key={space.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
            <Msg root={stream}>
              <Who>明知</Who>
              <p className="hero">把一条口播，<br />变成 <It>finished cut.</It></p>
              <p className="say">拖进口播，选好背景、字幕和封面，<span className="hl">剩下的交给我</span>：剪掉口误和气口、配 <span className="nw">B-roll</span>、做封面，给你一条能直接发的竖屏成片。</p>
            </Msg>
            {showKey && <Msg root={stream} delay={0.06}><KeyCard onVerified={wb.keyVerified} /></Msg>}
            <Msg root={stream} delay={0.12}><SetupCard wb={wb} space={space} options={options} /></Msg>
            {space.versions.length > 0 && <Msg root={stream}><LivePending space={space} /></Msg>}
          </motion.div>
        </AnimatePresence>
      </div>
      <Dock wb={wb} space={space} composer={composer} keyReady={!!wb.status?.keyConfigured} />
    </section>
  );
}
