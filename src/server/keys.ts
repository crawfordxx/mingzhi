import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http.js';
import type { AppCtx } from './context.js';

export type KeySource = 'env' | 'keychain' | 'file';
export interface ActiveKey { key: string; source: KeySource }

/** 环境变量 MINGZHI_KX_KEY 优先，否则用 KeyStore；文件 <dataDir>/key 存在即来自文件，否则来自系统钥匙串 */
export async function activeKey(app: Pick<AppCtx, 'cfg' | 'keyStore'>): Promise<ActiveKey | null> {
  if (app.cfg.kexiangKey) return { key: app.cfg.kexiangKey, source: 'env' };
  const stored = await app.keyStore.get().catch(() => null);
  if (!stored) return null;
  return { key: stored, source: existsSync(join(app.cfg.dataDir, 'key')) ? 'file' : 'keychain' };
}

export async function requireKey(app: Pick<AppCtx, 'cfg' | 'keyStore'>): Promise<string> {
  const active = await activeKey(app);
  if (!active) throw new HttpError(400, '还没有配置可想 AI key，请先在设置里填入');
  return active.key;
}

/** 只露出末 4 位，如 sk-…ab12 */
export function maskKey(key: string): string {
  return `${key.startsWith('sk-') ? 'sk-' : ''}…${key.slice(-4)}`;
}

/** 错误文案里不能出现 key（包括带 sk- 前缀与不带的两种写法） */
export function redact(text: string, key: string | undefined): string {
  const bare = key?.startsWith('sk-') ? key.slice(3) : key;
  if (!bare || bare.length < 6) return text; // 太短的串会误伤正常文案
  return text.split(`sk-${bare}`).join('***').split(bare).join('***');
}
