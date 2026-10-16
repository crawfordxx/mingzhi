import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import type { CostMeter } from '../cost/meter.js';
import { loadPrices, type Price } from '../cost/prices.js';
import type { LlmClient } from '../llm/kexiang.js';
import { KexiangClient } from '../llm/kexiang.js';
import { KexiangTaskClient } from '../llm/kexiang-task.js';
import { probe, type MediaInfo } from '../media/probe.js';
import type { CaptionStyleId } from '../captions/styles.js';
import { validateKey, type KeyStore } from '../workspace/keychain.js';
import { EventBus } from '../workspace/events.js';
import { runFirstVersion, runNextVersion, type RunnerCtx } from '../workspace/runner.js';
import { SpaceStore } from '../workspace/store.js';
import type { VersionMeta } from '../workspace/store.js';
import type { EditOp } from '../edit/plan.js';
import { renderCaptionPreview } from './preview.js';
import { makeBackgroundThumb } from './thumbs.js';
import type { KeyCache } from './keys.js';
import type { StockKeys, StockStores } from './stock-keys.js';
import { validateStockKey, type StockProvider } from './stock-validate.js';
import type { Activity } from './lifecycle.js';
import type { RunManager } from './runs.js';
import type { UpdateInfo } from './update.js';

/** 可替换的外部依赖：默认是真实实现，测试注入假的 */
export interface AppDeps {
  validateKey: (key: string) => Promise<boolean>;
  /** 校验图库 key：有效 true、无效 false、暂时无法判断抛错 */
  validateStockKey: (provider: StockProvider, key: string) => Promise<boolean>;
  probe: (path: string) => Promise<MediaInfo>;
  planClient: (key: string, meter: CostMeter) => LlmClient;
  loadPrices: (key: string) => Promise<Record<string, Price>>;
  runFirst: (ctx: RunnerCtx, spaceId: string) => Promise<VersionMeta>;
  runNext: (ctx: RunnerCtx, spaceId: string, parent: number, ops: EditOp[], summary: string) => Promise<VersionMeta>;
  /** 在默认 RunnerCtx 上叠加（测试注入假媒体处理等） */
  ctxOverrides?: Partial<RunnerCtx>;
  makeThumb: (src: string, dest: string) => Promise<void>;
  renderCaptionPreview: (id: CaptionStyleId, dest: string) => Promise<void>;
}

export interface AppOptions {
  cfg: AppConfig;
  keyStore?: KeyStore;
  /** 图库 key 的存放；缺省：传了 keyStore（测试、假模型）就只用数据目录文件，否则系统钥匙串优先 */
  stockStores?: StockStores;
  /** 前端构建目录，默认仓库的 web/dist */
  webDir?: string;
  /** 导出目录，默认 ~/Downloads/明知AI剪辑 */
  exportDir?: string;
  /** 开发时前端 dev server 的端口（vite 代理不改写 Host/Origin），默认读环境变量 MINGZHI_DEV_PORT */
  devPort?: number;
  deps?: Partial<AppDeps>;
  /** 检查更新（src/server/update.ts）；不给时不查（测试、假模式） */
  updates?: UpdateSource;
  /** 优雅停止（POST /api/shutdown 或空闲退出）完成后调用；正式运行时是 process.exit */
  onExit?: (code: number) => void;
  /** 无请求、无任务满这么久自动退出；不给时不自动退出 */
  idleExitMs?: number;
  /** 空闲检查间隔，默认 1 分钟 */
  idleCheckMs?: number;
  /** 空闲计时用的时钟（测试注入假时钟，免得 CPU 繁忙时真实时间抖动导致误退出），默认 Date.now */
  idleClock?: () => number;
}

/** 检查更新的最小接口：有新版本时 available() 返回它；poke() 到时间才真去查 */
export interface UpdateSource {
  available: () => UpdateInfo | null;
  poke: () => Promise<void>;
}

export interface AppCtx {
  cfg: AppConfig;
  store: SpaceStore;
  bus: EventBus;
  spacesRoot: string;
  keyStore: KeyStore;
  keys: KeyCache;
  stock: StockKeys;
  /** 抹掉文字里的本机绝对路径（事件与错误响应） */
  scrub: (text: string) => string;
  deps: AppDeps;
  runs: RunManager;
  webDir: string;
  exportDir: string;
  devPort?: number;
  /** 当前监听端口（listen 之后才有意义） */
  port: () => number;
  /** 进行中的请求与最后活动时间（空闲退出用） */
  activity: Activity;
  updates?: UpdateSource;
  /** 开始优雅停止，完成后以 0 退出（重复调用只停一次） */
  requestShutdown: () => void;
}

export function buildDeps(cfg: AppConfig, over: Partial<AppDeps> = {}): AppDeps {
  const base: AppDeps = {
    validateKey: (key) => validateKey(key),
    validateStockKey: (provider, key) => validateStockKey(provider, key),
    probe: (path) => probe(path, cfg),
    planClient: (key, meter) => new KexiangClient(key, undefined, undefined, meter),
    loadPrices: (key) => loadPrices(join(cfg.dataDir, 'prices.json'), fetch, Date.now, key),
    runFirst: runFirstVersion,
    runNext: runNextVersion,
    makeThumb: (src, dest) => makeBackgroundThumb(cfg, src, dest),
    renderCaptionPreview: (id, dest) => renderCaptionPreview(cfg, id, dest),
  };
  return { ...base, ...over };
}

export const defaultExportDir = (): string => join(homedir(), 'Downloads', '明知AI剪辑');

/** 默认的任务上下文：模型与任务客户端用当前 key 构造，花费记到本版本的计费器 */
export async function defaultRunnerCtx(app: Pick<AppCtx, 'cfg' | 'store' | 'bus' | 'deps' | 'stock'>, key: string, signal: AbortSignal): Promise<RunnerCtx> {
  const prices = await loadPricesOrEmpty(app.deps, key);
  return {
    store: app.store, bus: app.bus, cfg: { ...app.cfg, ...(await app.stock.asConfig()), kexiangKey: key }, prices, signal,
    clients: (meter) => ({
      llm: new KexiangClient(key, undefined, undefined, meter),
      task: new KexiangTaskClient(key, undefined, undefined, undefined, meter),
    }),
    ...app.deps.ctxOverrides,
  };
}

/** 取不到价格表时退化为空表（成本按内置最贵价估算），但留一行告警 */
export async function loadPricesOrEmpty(deps: Pick<AppDeps, 'loadPrices'>, key: string): Promise<Record<string, Price>> {
  try {
    return await deps.loadPrices(key);
  } catch (err) {
    console.warn(`读取模型价格表失败，按内置价估算：${err instanceof Error ? err.message.split(key).join('***') : '未知错误'}`);
    return {};
  }
}
