/**
 * 素材来源面板（G1）：从右侧滑出，逐条列出这一版用到的素材——缩略图、来源、作者、许可、是否 AI 生成、加工项；
 * CC BY 与网页截图带提示；每条可「替换」「删除」；底部是署名文本，可复制。纯展示，数据与动作由 useCredits 提供
 */
import { motion } from 'motion/react';
import type { Ref } from 'react';
import type { CreditItem, CreditMark, Credits } from '../api';
import { hostOf, markText, modifiedLabels, noticeOf, panelNotices, safeHref, sourceLabel, summaryOf } from '../lib/credits';
import { Ico, It, SOFT, Tap } from '../ui';

export type CreditsView = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; credits: Credits };

interface Props {
  version: number;
  view: CreditsView;
  /** 正在处理的素材文件名（按钮转圈、不可再点） */
  busy?: string;
  /** 标记后修改已成功提交的素材（没提交成功的，同一动作的按钮变成「重试」） */
  submitted?: ReadonlySet<string>;
  /** 面板根元素（抽屉用它移入焦点、限制 Tab） */
  panelRef?: Ref<HTMLElement>;
  onMark: (item: CreditItem, action: CreditMark) => void;
  onCopy: () => void;
  onClose: () => void;
}

function Thumb({ item }: { item: CreditItem }) {
  return (
    <span className="cred-th">
      {item.kind === 'video'
        ? <video src={item.thumb} muted playsInline preload="metadata" aria-hidden="true" />
        : <img src={item.thumb} alt="" loading="lazy" />}
      {item.aiGenerated && <i className="cred-ai" aria-hidden="true">AI</i>}
    </span>
  );
}

function Who({ item }: { item: CreditItem }) {
  const host = hostOf(item.page);
  const authorUrl = safeHref(item.authorUrl);
  const page = safeHref(item.page);
  return (
    <div className="cred-t">
      <b>{sourceLabel(item.source)}</b>
      {item.author && <span className="cred-by">· {authorUrl ? <a href={authorUrl} target="_blank" rel="noreferrer">{item.author}</a> : item.author}</span>}
      {page && <a className="cred-src" href={page} target="_blank" rel="noreferrer">{item.source === 'screenshot' ? host : '作品页'}{Ico.ext}</a>}
    </div>
  );
}

function Meta({ item }: { item: CreditItem }) {
  const labels = modifiedLabels(item.modified);
  const showLicense = !(item.aiGenerated && item.license === 'AI 生成');
  const licenseUrl = safeHref(item.licenseUrl);
  return (
    <div className="cred-meta">
      {item.aiGenerated && <span className="cred-chip ai">AI 生成</span>}
      {showLicense && (licenseUrl
        ? <a className="cred-chip lic" href={licenseUrl} target="_blank" rel="noreferrer">{item.license}</a>
        : <span className="cred-chip lic">{item.license}</span>)}
      {labels.map((l) => <span key={l} className="cred-chip mod">{l}</span>)}
    </div>
  );
}

const ACTION_LABEL: Record<CreditMark, string> = { replace: '替换', remove: '删除' };

/** 读屏用的素材名：来源 + 作者 + 文件名（+ 镜头序号） */
const nameOf = (item: CreditItem): string =>
  [sourceLabel(item.source), item.author, item.file, item.shotIndex !== undefined ? `镜头 ${item.shotIndex + 1}` : undefined].filter(Boolean).join(' ');

function Row({ item, busy, submitted, onMark }: { item: CreditItem; busy: boolean; submitted: boolean; onMark: Props['onMark'] }) {
  const notice = noticeOf(item);
  const button = (action: CreditMark, cls: string) => {
    // 已标记但修改没提交成功：同一动作可重试；提交成功后才禁用
    const retry = item.mark === action && !submitted;
    const label = `${retry ? '重试' : ''}${ACTION_LABEL[action]}`;
    return (
      <Tap className={`btn ${cls} sm`} disabled={busy || (item.mark === action && submitted)} aria-label={`${label}：${nameOf(item)}`} onClick={() => onMark(item, action)}>{label}</Tap>
    );
  };
  return (
    <li className={`cred-row${item.mark ? ' marked' : ''}`}>
      <Thumb item={item} />
      <div className="cred-b">
        <Who item={item} />
        <Meta item={item} />
        {notice && <p className={`cred-n ${notice.kind}`}>{notice.short}</p>}
        <div className="cred-act">
          {busy ? <span className="cred-mark"><span className="spin" />正在提交…</span> : item.mark && <span className="cred-mark">{Ico.check}{markText(item.mark)}</span>}
          <span className="cred-btns">{button('replace', 'btn-g')}{button('remove', 'btn-w')}</span>
        </div>
      </div>
    </li>
  );
}

function Body({ view, busy, submitted, onMark }: Pick<Props, 'view' | 'busy' | 'submitted' | 'onMark'>) {
  if (view.kind === 'loading') return <p className="cred-empty"><span className="spin" />正在读取素材来源…</p>;
  if (view.kind === 'error') return <p className="cred-empty err" role="alert">{view.message}</p>;
  const { entries } = view.credits;
  if (entries.length === 0) return <p className="cred-empty">这一版没有用到外部素材。<It>(B-roll 为空，或这是旧版本)</It></p>;
  return <ul className="cred-list">{entries.map((e) => <Row key={e.file} item={e} busy={busy === e.file} submitted={submitted?.has(e.file) ?? false} onMark={onMark} />)}</ul>;
}

export function CreditsPanel({ version, view, busy, submitted, panelRef, onMark, onCopy, onClose }: Props) {
  const entries = view.kind === 'ready' ? view.credits.entries : [];
  const attribution = view.kind === 'ready' ? view.credits.attribution : '';
  return (
    <motion.aside ref={panelRef} className="cred" role="dialog" aria-modal="true" aria-labelledby="cred-title" tabIndex={-1} initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }} transition={SOFT}>
      <header className="cred-h">
        <div>
          <h2 id="cred-title">素材来源 <It l className="cred-v">(v{version})</It></h2>
          <p className="cred-sum">{view.kind === 'ready' ? summaryOf(entries) : '本版用到的每一条外部素材与它的授权'}</p>
        </div>
        <button type="button" className="cred-x" onClick={onClose} aria-label="关闭素材来源">{Ico.close}</button>
      </header>
      {panelNotices(entries).map((n) => <p key={n.kind} className={`cred-note ${n.kind}`}>{n.text}</p>)}
      <div className="cred-scroll"><Body view={view} busy={busy} submitted={submitted} onMark={onMark} /></div>
      {attribution && (
        <footer className="cred-foot">
          <div className="cred-fh"><b>署名文本</b><It>(发布时贴在正文末尾)</It></div>
          <p className="cred-attr">{attribution}</p>
          <Tap className="btn btn-k sm" onClick={onCopy}>复制署名文本</Tap>
        </footer>
      )}
    </motion.aside>
  );
}
