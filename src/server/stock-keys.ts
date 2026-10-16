import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import { createKeyStore, fileKeyStore, PEXELS_SLOT, PIXABAY_SLOT, type KeySlot, type KeyStore } from '../workspace/keychain.js';
import { maskKey, type ActiveKey } from './keys.js';
import { STOCK_PROVIDERS, type StockProvider } from './stock-validate.js';

export interface StockKeyInfo { configured: boolean; source?: ActiveKey['source']; masked?: string }
export type StockKeysInfo = Record<StockProvider, StockKeyInfo>;
export type StockStores = Record<StockProvider, KeyStore>;

const SLOTS: Record<StockProvider, KeySlot> = { pexels: PEXELS_SLOT, pixabay: PIXABAY_SLOT };

/** 真实运行：系统钥匙串优先、文件 600 兜底 */
export const keychainStockStores = (dataDir: string): StockStores => ({
  pexels: createKeyStore(dataDir, process.platform, undefined, PEXELS_SLOT),
  pixabay: createKeyStore(dataDir, process.platform, undefined, PIXABAY_SLOT),
});

/** 只用数据目录下的文件：测试与假模型模式（不碰系统钥匙串） */
export const fileStockStores = (dataDir: string): StockStores => ({
  pexels: fileKeyStore(dataDir, PEXELS_SLOT),
  pixabay: fileKeyStore(dataDir, PIXABAY_SLOT),
});

const ENV_KEY: Record<StockProvider, 'pexelsKey' | 'pixabayKey'> = { pexels: 'pexelsKey', pixabay: 'pixabayKey' };

/**
 * 图库 key（Pexels、Pixabay，选填）。环境变量 MINGZHI_PEXELS_KEY / MINGZHI_PIXABAY_KEY 优先，否则读 KeyStore。
 * 读到或保存的 key 都登记到 remember（抹除错误文案与事件流里的 key）；key 永远不出现在 info 里，只给末 4 位
 */
export class StockKeys {
  constructor(
    private readonly cfg: Pick<AppConfig, 'dataDir' | 'pexelsKey' | 'pixabayKey'>,
    private readonly stores: StockStores,
    private readonly remember: (key: string) => void,
  ) {
    for (const p of STOCK_PROVIDERS) {
      const env = cfg[ENV_KEY[p]];
      if (env) remember(env);
    }
  }

  async get(provider: StockProvider): Promise<ActiveKey | null> {
    const env = this.cfg[ENV_KEY[provider]];
    if (env) return { key: env, source: 'env' };
    const stored = await this.stores[provider].get().catch(() => null);
    if (!stored) return null;
    this.remember(stored);
    return { key: stored, source: existsSync(join(this.cfg.dataDir, SLOTS[provider].file)) ? 'file' : 'keychain' };
  }

  async info(provider: StockProvider): Promise<StockKeyInfo> {
    const active = await this.get(provider);
    return active ? { configured: true, source: active.source, masked: maskKey(active.key) } : { configured: false };
  }

  async infoAll(): Promise<StockKeysInfo> {
    const [pexels, pixabay] = await Promise.all(STOCK_PROVIDERS.map((p) => this.info(p)));
    return { pexels, pixabay };
  }

  /** 交给流水线的配置字段：只含已配置的来源 */
  async asConfig(): Promise<Partial<Pick<AppConfig, 'pexelsKey' | 'pixabayKey'>>> {
    const [pexels, pixabay] = await Promise.all(STOCK_PROVIDERS.map((p) => this.get(p)));
    return { ...(pexels ? { pexelsKey: pexels.key } : {}), ...(pixabay ? { pixabayKey: pixabay.key } : {}) };
  }

  async set(provider: StockProvider, key: string): Promise<void> {
    this.remember(key);
    await this.stores[provider].set(key);
  }

  async clear(provider: StockProvider): Promise<void> {
    await this.stores[provider].clear();
  }
}
