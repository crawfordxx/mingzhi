/**
 * 素材来源面板（G1）：从右侧滑出，逐条列出这一版用到的素材——缩略图、来源、作者、许可、是否 AI 生成、加工项；
 * CC BY 与网页截图带提示；每条可「替换」「删除」；底部是署名文本，可复制。纯展示，数据与动作由 useCredits 提供
 */
import { motion } from 'motion/react';
import type { CreditItem, CreditMark, Credits } from '../api';
import { hostOf, markText, modifiedLabels, noticeOf, panelNotices, sourceLabel, summaryOf } from '../lib/credits';
import { Ico, It, SOFT, Tap } from '../ui';

export type CreditsView = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; credits: Credits };

interface Props {
  version: number;
  view: CreditsView;
  /** 正在处理的素材文件名（按钮转圈、不可再点） */
  busy?: string;
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
  return (
    <div className="cred-t">
      <b>{sourceLabel(item.source)}</b>
      {item.author && <span className="cred-by">· {item.authorUrl ? <a href={item.authorUrl} target="_blank" rel="noreferrer">{item.author}</a> : item.author}</span>}
      {item.page && <a className="cred-src" href={item.page} target="_blank" rel="noreferrer">{item.source === 'screenshot' ? host : '作品页'}{Ico.ext}</a>}
    </div>
  );
}

function Meta({ item }: { item: CreditItem }) {
  const labels = modifiedLabels(item.modified);
  const showLicense = !(item.aiGenerated && item.license === 'AI 生成');
  return (
    <div className="cred-meta">
      {item.aiGenerated && <span className="cred-chip ai">AI 生成</span>}
      {showLicense && (item.licenseUrl
        ? <a className="cred-chip lic" href={item.licenseUrl} target="_blank" rel="noreferrer">{item.license}</a>
        : <span className="cred-chip lic">{item.license}</span>)}
      {labels.map((l) => <span key={l} className="cred-chip mod">{l}</span>)}
    </div>
  );
}

function Row({ item, busy, onMark }: { item: CreditItem; busy: boolean; onMark: Props['onMark'] }) {
  const notice = noticeOf(item);
  const button = (action: CreditMark, label: string, cls: string) => (
    <Tap className={`btn ${cls} sm`} disabled={busy || item.mark === action} onClick={() => onMark(item, action)}>{label}</Tap>
  );
  return (
    <li className={`cred-row${item.mark ? ' marked' : ''}`}>
      <Thumb item={item} />
      <div className="cred-b">
        <Who item={item} />
        <Meta item={item} />
        {notice && <p className={`cred-n ${notice.kind}`}>{notice.short}</p>}
        <div className="cred-act">
          {busy ? <span className="cred-mark"><span className="spin" />正在提交…</span> : item.mark && <span className="cred-mark">{Ico.check}{markText(item.mark)}</span>}
          <span className="cred-btns">{button('replace', '替换', 'btn-g')}{button('remove', '删除', 'btn-w')}</span>
        </div>
      </div>
    </li>
  );
}

function Body({ view, busy, onMark }: Pick<Props, 'view' | 'busy' | 'onMark'>) {
  if (view.kind === 'loading') return <p className="cred-empty"><span className="spin" />正在读取素材来源…</p>;
  if (view.kind === 'error') return <p className="cred-empty err" role="alert">{view.message}</p>;
  const { entries } = view.credits;
  if (entries.length === 0) return <p className="cred-empty">这一版没有用到外部素材。<It>(B-roll 为空，或这是旧版本)</It></p>;
  return <ul className="cred-list">{entries.map((e) => <Row key={e.file} item={e} busy={busy === e.file} onMark={onMark} />)}</ul>;
}

export function CreditsPanel({ version, view, busy, onMark, onCopy, onClose }: Props) {
  const entries = view.kind === 'ready' ? view.credits.entries : [];
  const attribution = view.kind === 'ready' ? view.credits.attribution : '';
  return (
    <motion.aside className="cred" role="dialog" aria-label="素材来源" initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }} transition={SOFT}>
      <header className="cred-h">
        <div>
          <h2>素材来源 <It l className="cred-v">(v{version})</It></h2>
          <p className="cred-sum">{view.kind === 'ready' ? summaryOf(entries) : '本版用到的每一条外部素材与它的授权'}</p>
        </div>
        <button type="button" className="cred-x" onClick={onClose} aria-label="关闭素材来源">{Ico.close}</button>
      </header>
      {panelNotices(entries).map((n) => <p key={n.kind} className={`cred-note ${n.kind}`}>{n.text}</p>)}
      <div className="cred-scroll"><Body view={view} busy={busy} onMark={onMark} /></div>
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
