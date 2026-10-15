import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { DEFAULT_PORT, startApp } from './app.js';

export { createApp, startApp } from './app.js';

async function main(): Promise<void> {
  const requested = Number(process.env.MINGZHI_PORT) || DEFAULT_PORT;
  const running = await startApp({ cfg: loadConfig() }, requested);
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
