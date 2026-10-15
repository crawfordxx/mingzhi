/**
 * 设置卡：口播 → 背景 → 字幕 → 封面；预算、预估与「开始出片」是它的底栏，
 * 固定在对话区底部（setup/BudgetFooter.tsx，开始出片后让位给输入框）。开始后卡片收成一行摘要（G1 设置卡）
 */
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { Options, Space } from '../api';
import type { Workbench } from '../useWorkbench';
import { It, SOFT } from '../ui';
import { BackgroundPicker } from './setup/BackgroundPicker';
import { InputsDrop } from './setup/InputsDrop';
import { CaptionPicker, CoverPicker } from './setup/StylePickers';

export const DEFAULT_COVER = 'bauhaus';

/** 当前背景的显示名与缩略图（预设才有缩略图） */
export function backgroundLabel(space: Space, options: Options): { name: string; thumb?: string } {
  const bg = space.settings.background;
  if (!bg) return { name: '原背景' };
  if (bg.kind === 'preset') {
    const o = options.backgrounds.find((x) => x.id === bg.id);
    return { name: o?.name ?? bg.id, thumb: o?.thumb };
  }
  if (bg.kind === 'file') return { name: bg.path.split(/[\\/]/).pop() ?? '自定义图片' };
  return { name: `「${bg.prompt.length > 10 ? `${bg.prompt.slice(0, 10)}…` : bg.prompt}」` };
}

function Section({ n, title, value, aside, children }: { n: number; title: string; value?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="sec">
      <header className="sec-h">
        <It className="sec-n">{`0${n}`}</It>
        <h3>{title}</h3>
        {value !== undefined && <span className="sec-v">{value}</span>}
        {aside && <span className="sec-aside">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

interface Props { wb: Workbench; space: Space; options: Options }

export function blockerOf(wb: Workbench, space: Space, keyReady: boolean): string | undefined {
  if (!keyReady) return '先在上方连上可想 AI';
  if (wb.uploads.some((u) => u.state === 'uploading')) return '等口播传完…';
  if (!space.inputs.length) return '先放入至少一段口播';
  return undefined;
}

export function SetupCard({ wb, space, options }: Props) {
  const s = space.settings;
  const bg = backgroundLabel(space, options);
  const cap = options.captionStyles.find((c) => c.id === s.captionStyle);
  const coverId = s.coverStyle ?? DEFAULT_COVER;
  const cover = options.coverStyles.find((c) => c.id === coverId);

  if (space.versions.length) {
    return (
      <motion.div layout className="card setup-sum" transition={SOFT}>
        <b>设置</b>
        {[space.inputs.length > 1 ? `${space.inputs.length} 段口播` : space.inputs[0], bg.name, cap?.name, cover?.name].filter(Boolean).map((t) => (
          <span key={t}><span className="dot">·</span>{t}</span>
        ))}
        <It className="more">(上限 ¥{s.budgetYuan})</It>
      </motion.div>
    );
  }

  return (
    <motion.div layout className="card setup" transition={SOFT}>
      <Section n={1} title="口播" value={space.inputs.length ? `${space.inputs.length} 段` : undefined} aside={<It>(1–N 段)</It>}>
        <InputsDrop inputs={space.inputs} uploads={wb.uploads} onFiles={wb.addInputs} onDismiss={wb.dropUpload} />
      </Section>
      <Section n={2} title="背景" value={bg.name}
        aside={<button type="button" className={`keep${s.background ? '' : ' on'}`} onClick={() => wb.updateSettings({ background: undefined })} aria-pressed={!s.background}>不换背景</button>}>
        <BackgroundPicker options={options.backgrounds} value={s.background} uploading={wb.bgUpload}
          onChange={(b) => wb.updateSettings({ background: b })} onUpload={wb.uploadBackground} />
      </Section>
      <Section n={3} title="字幕样式" value={cap?.name}>
        <CaptionPicker options={options.captionStyles} value={s.captionStyle} backdrop={bg.thumb} onChange={(id) => wb.updateSettings({ captionStyle: id })} />
      </Section>
      <Section n={4} title="封面风格" value={cover?.name} aside={<It>(示例图，不含真人)</It>}>
        <CoverPicker options={options.coverStyles} value={coverId} onChange={(id) => wb.updateSettings({ coverStyle: id })} />
      </Section>
    </motion.div>
  );
}
