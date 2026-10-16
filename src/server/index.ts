import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { DEFAULT_PORT, startApp } from './app.js';
import { fakeAppOptions, FAKE_LLM_ENV, isFakeMode } from './fake.js';
import { readPrefs } from './prefs.js';
import { appVersion, UpdateChecker } from './update.js';

export { createApp, startApp } from './app.js';

/** 没有浏览器连着、没有任务满 2 小时自动退出 */
const IDLE_EXIT_MS = 2 * 3600_000;

async function main(): Promise<void> {
  const requested = Number(process.env.MINGZHI_PORT) || DEFAULT_PORT;
  const cfg = loadConfig();
  const fake = isFakeMode();
  // MINGZHI_EXPORT_DIR：导出目录（端到端测试用临时目录，避免写进用户的「下载」）
  const exportDir = process.env.MINGZHI_EXPORT_DIR || undefined;
  // 假模式（测试）不查更新，免得测试去请求 GitHub
  const updates = fake ? undefined : new UpdateChecker({ dataDir: cfg.dataDir, current: appVersion(), enabled: () => readPrefs(cfg.dataDir).checkUpdates });
  const lifecycle = { updates, idleExitMs: IDLE_EXIT_MS, onExit: (code: number) => process.exit(code) };
  const running = await startApp({ cfg, ...lifecycle, ...(exportDir ? { exportDir } : {}), ...(fake ? fakeAppOptions(cfg) : {}) }, requested);
  if (fake) console.warn(`${FAKE_LLM_ENV}=1：假模型模式（仅测试用），不调用可想 AI、不花钱`);
  console.log(`明知AI剪辑 已启动：${running.url}`);
  if (running.port !== requested) console.log(`（端口 ${requested} 被占用，已顺延到 ${running.port}）`);
  void updates?.poke();
  // Ctrl+C、启动器的看门狗（stdin 关闭后发 SIGTERM）与「退出」按钮走同一套优雅停止
  const stop = (): void => {
    void running.shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/**
 * 是否被直接运行（而不是被测试等 import）。比较真实路径：ESM 的 import.meta.url 已解析过符号链接，
 * argv[1] 可能经过符号链接 / Windows junction，直接比字符串会静默不启动。
 */
export function isEntry(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntry(import.meta.url, process.argv[1])) {
  main().catch((err: Error) => {
    console.error(`启动失败：${err.message}`);
    process.exit(1);
  });
}
