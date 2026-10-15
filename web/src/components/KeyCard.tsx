/** 首次无 key：输入框 + 去可想 AI 注册（不带邀请码）+ 校验状态；通过后收成一行 */
import { AnimatePresence, motion, useAnimationControls } from 'motion/react';
import { useState, type FormEvent } from 'react';
import { api, type KeyInfo, type KeySource } from '../api';
import { Ico, It, SOFT, SPRING, Tap } from '../ui';
import { KEXIANG_URL } from './AnnouncementBar';

type Phase = { kind: 'idle' } | { kind: 'checking' } | { kind: 'error'; message: string } | { kind: 'ok'; info: KeyInfo };

/** 按服务端返回的实际存储位置说明 key 在哪（安全相关，不能写死） */
const WHERE: Record<KeySource, string> = { keychain: '(存在系统钥匙串)', file: '(存在本机数据目录，仅本人可读)', env: '(来自环境变量 MINGZHI_KX_KEY)' };

function KeyDone({ info }: { info: KeyInfo }) {
  return (
    <motion.div layout className="card key-done" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={SOFT}>
      <motion.span className="key-ok" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ ...SPRING, delay: 0.1 }}>{Ico.check}</motion.span>
      <span>可想 AI 已连接</span>
      <span className="key-mask">{info.masked ?? ''}</span>
      {info.source && <It className="key-where">{WHERE[info.source]}</It>}
    </motion.div>
  );
}

/** 状态行（空闲 / 校验中 / 失败原因）+ 注册链接 */
function KeyFoot({ phase }: { phase: Phase }) {
  return (
    <div className="key-foot">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={phase.kind} className={`key-msg ${phase.kind}`} role={phase.kind === 'error' ? 'alert' : undefined}
          initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
          {phase.kind === 'error' ? phase.message : phase.kind === 'checking' ? '正在向可想 AI 请求模型列表…' : <>{Ico.lock}保存前会先校验一次</>}
        </motion.span>
      </AnimatePresence>
      <a className="key-reg" href={KEXIANG_URL} target="_blank" rel="noreferrer">还没有账号？<b>去可想 AI 注册</b>{Ico.ext}</a>
    </div>
  );
}

const SHAKE = { x: [0, -6, 6, -3, 3, 0], transition: { duration: 0.36 } };

export function KeyCard({ onVerified }: { onVerified: () => void }) {
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const shake = useAnimationControls();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (!key) { setPhase({ kind: 'error', message: '先粘贴可想 AI 的 key' }); void shake.start(SHAKE); return; }
    setPhase({ kind: 'checking' });
    try {
      const info = await api.saveKey(key);
      setValue('');
      setPhase({ kind: 'ok', info });
      onVerified();
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      void shake.start(SHAKE);
    }
  };

  if (phase.kind === 'ok') return <KeyDone info={phase.info} />;

  const checking = phase.kind === 'checking';
  return (
    <motion.form layout className="card keycard" onSubmit={submit} transition={SOFT} noValidate>
      <div className="key-head">
        <span className="key-ico">{Ico.key}</span>
        <div>
          <h3>先连上可想 AI <It l>(只需一次)</It></h3>
          <p>剪口误、配图和做封面会调用可想 AI 的模型。key 只保存在这台电脑上（优先系统钥匙串），不会上传到别处。</p>
        </div>
      </div>
      <motion.div className={`key-row${phase.kind === 'error' ? ' bad' : ''}`} animate={shake}>
        <div className="key-field">
          <input type={reveal ? 'text' : 'password'} value={value} placeholder="sk-…" autoComplete="new-password" spellCheck={false} disabled={checking}
            aria-label="可想 AI key" name="kexiang-key" data-1p-ignore data-lpignore="true"
            onChange={(e) => { setValue(e.target.value); if (phase.kind === 'error') setPhase({ kind: 'idle' }); }} />
          <button type="button" className="key-eye" onClick={() => setReveal((r) => !r)} aria-pressed={reveal}>{reveal ? '隐藏' : '显示'}</button>
        </div>
        <Tap type="submit" className="btn btn-k key-go" disabled={checking}>
          {checking ? <><span className="spin" />校验中</> : '校验并保存'}
        </Tap>
      </motion.div>
      <KeyFoot phase={phase} />
    </motion.form>
  );
}
