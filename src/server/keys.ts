import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import type { KeyStore } from '../workspace/keychain.js';
import type { AppCtx } from './context.js';
import { HttpError } from './http.js';

export type KeySource = 'env' | 'keychain' | 'file';
export interface ActiveKey { key: string; source: KeySource }

const KEY_TTL_MS = 10_000;
const MIN_KEY_CHARS = 6;
const REDACTED = 'sk-***';
/** 任何 sk- 开头的长串都当作 key */
const KEY_LIKE = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g;

/**
 * 当前 key 的短时缓存（避免每次错误响应、每次状态轮询都起一个 security 子进程读钥匙串），
 * 同时记住本进程见过的所有 key，用于抹除错误文案与事件流里的 key。
 * 环境变量 MINGZHI_KX_KEY 优先，否则用 KeyStore；文件 <dataDir>/key 存在即来自文件，否则来自系统钥匙串。
 */
export class KeyCache {
  private cached: { value: ActiveKey | null; at: number } | null = null;
  private seen: readonly string[] = [];

  constructor(
    private readonly cfg: Pick<AppConfig, 'dataDir' | 'kexiangKey'>,
    private readonly store: KeyStore,
    private readonly now: () => number = Date.now,
  ) {
    if (cfg.kexiangKey) this.remember(cfg.kexiangKey);
  }

  async get(): Promise<ActiveKey | null> {
    if (this.cached && this.now() - this.cached.at < KEY_TTL_MS) return this.cached.value;
    const value = await this.load();
    this.cached = { value, at: this.now() };
    if (value) this.remember(value.key);
    return value;
  }

  /** 写入或清除 key 之后调用，下一次读取重新取 */
  invalidate(): void {
    this.cached = null;
  }

  /** 抹除文本里的 key（当前的、本进程见过的，以及任何 sk- 开头的长串）→ sk-*** */
  redact(text: string): string {
    const bare = (k: string): string => (k.startsWith('sk-') ? k.slice(3) : k);
    const known = this.seen.map(bare).filter((k) => k.length >= MIN_KEY_CHARS);
    const stripped = known.reduce((t, k) => t.split(`sk-${k}`).join(REDACTED).split(k).join(REDACTED), text);
    return stripped.replace(KEY_LIKE, REDACTED);
  }

  private remember(key: string): void {
    if (!this.seen.includes(key)) this.seen = [...this.seen, key];
  }

  private async load(): Promise<ActiveKey | null> {
    if (this.cfg.kexiangKey) return { key: this.cfg.kexiangKey, source: 'env' };
    const stored = await this.store.get().catch(() => null);
    if (!stored) return null;
    return { key: stored, source: existsSync(join(this.cfg.dataDir, 'key')) ? 'file' : 'keychain' };
  }
}

export const activeKey = (app: Pick<AppCtx, 'keys'>): Promise<ActiveKey | null> => app.keys.get();

export async function requireKey(app: Pick<AppCtx, 'keys'>): Promise<string> {
  const active = await app.keys.get();
  if (!active) throw new HttpError(400, '还没有配置可想 AI key，请先在设置里填入');
  return active.key;
}

/** 只露出末 4 位，如 sk-…ab12 */
export function maskKey(key: string): string {
  return `${key.startsWith('sk-') ? 'sk-' : ''}…${key.slice(-4)}`;
}
