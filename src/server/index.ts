import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { DEFAULT_PORT, startApp } from './app.js';
import { fakeAppOptions, FAKE_LLM_ENV, isFakeMode } from './fake.js';

export { createApp, startApp } from './app.js';

async function main(): Promise<void> {
  const requested = Number(process.env.MINGZHI_PORT) || DEFAULT_PORT;
  const cfg = loadConfig();
  const fake = isFakeMode();
  // MINGZHI_EXPORT_DIR：导出目录（端到端测试用临时目录，避免写进用户的「下载」）
  const exportDir = process.env.MINGZHI_EXPORT_DIR || undefined;
  const running = await startApp({ cfg, ...(exportDir ? { exportDir } : {}), ...(fake ? fakeAppOptions(cfg) : {}) }, requested);
  if (fake) console.warn(`${FAKE_LLM_ENV}=1：假模型模式（仅测试用），不调用可想 AI、不花钱`);
  console.log(`明知AI剪辑 已启动：${running.url}`);
  if (running.port !== requested) console.log(`（端口 ${requested} 被占用，已顺延到 ${running.port}）`);
  const stop = (): void => {
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: Error) => {
    console.error(`启动失败：${err.message}`);
    process.exit(1);
  });
}
