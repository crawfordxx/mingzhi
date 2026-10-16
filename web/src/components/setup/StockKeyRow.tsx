/** 设置里「图库（选填）」的一行：Pexels / Pixabay 的 key 输入 + 注册链接 + 校验状态 */
import { useState, type FormEvent } from 'react';
import type { KeySource, StockKeyInfo, StockProvider } from '../../api';
import { Ico, Tap } from '../../ui';

export const STOCK_HELP = '填了就能用实拍视频空镜，不填也能出片';

export const STOCK_META: Record<StockProvider, { name: string; url: string; env: string }> = {
  pexels: { name: 'Pexels', url: 'https://www.pexels.com/api/', env: 'MINGZHI_PEXELS_KEY' },
  pixabay: { name: 'Pixabay', url: 'https://pixabay.com/api/docs/', env: 'MINGZHI_PIXABAY_KEY' },
};

const WHERE: Record<KeySource, string> = { keychain: '存在系统钥匙串', file: '存在本机数据目录，仅本人可读', env: '' };

type Phase = { kind: 'idle' } | { kind: 'checking' } | { kind: 'error'; message: string };

interface Props {
  provider: StockProvider;
  info: StockKeyInfo;
  onSave: (key: string) => Promise<void>;
  onRemove: () => void;
}

function Done({ provider, info, onRemove }: Pick<Props, 'provider' | 'info' | 'onRemove'>) {
  const meta = STOCK_META[provider];
  const where = info.source === 'env' ? `来自环境变量 ${meta.env}` : info.source ? WHERE[info.source] : '';
  return (
    <div className="stock-row done">
      <span className="stock-name"><span className="key-ok">{Ico.check}</span>{meta.name}</span>
      <span className="key-mask">{info.masked ?? ''}</span>
      <span className="stock-where">{where}</span>
      {info.source !== 'env' && <button type="button" className="stock-rm" onClick={onRemove}>移除</button>}
    </div>
  );
}

export function StockKeyRow({ provider, info, onSave, onRemove }: Props) {
  const meta = STOCK_META[provider];
  const [value, setValue] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  if (info.configured) return <Done provider={provider} info={info} onRemove={onRemove} />;

  const checking = phase.kind === 'checking';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (!key) { setPhase({ kind: 'error', message: `先粘贴 ${meta.name} 的 key` }); return; }
    setPhase({ kind: 'checking' });
    try {
      await onSave(key);
      setValue('');
      setPhase({ kind: 'idle' });
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };
  return (
    <form className="stock-row" onSubmit={submit} noValidate>
      <div className="stock-top">
        <span className="stock-name">{meta.name}</span>
        <a className="key-reg sm" href={meta.url} target="_blank" rel="noreferrer">去 {meta.name} 免费获取<b> key</b>{Ico.ext}</a>
      </div>
      <div className={`key-row${phase.kind === 'error' ? ' bad' : ''}`}>
        <div className="key-field">
          <input type="password" value={value} placeholder="粘贴 key（选填）" autoComplete="new-password" spellCheck={false} disabled={checking}
            aria-label={`${meta.name} key`} name={`${provider}-key`} data-1p-ignore data-lpignore="true"
            onChange={(e) => { setValue(e.target.value); if (phase.kind === 'error') setPhase({ kind: 'idle' }); }} />
        </div>
        <Tap type="submit" className="btn btn-k key-go" disabled={checking}>{checking ? <><span className="spin" />校验中</> : '校验并保存'}</Tap>
      </div>
      <p className={`stock-msg ${phase.kind}`} role={phase.kind === 'error' ? 'alert' : undefined}>
        {phase.kind === 'error' ? phase.message : phase.kind === 'checking' ? `正在向 ${meta.name} 发一次搜索请求…` : <>{Ico.lock}保存前会先校验一次，key 只存在这台电脑上</>}
      </p>
    </form>
  );
}
