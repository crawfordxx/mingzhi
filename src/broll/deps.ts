import type { AppConfig } from '../config.js';
import type { CostMeter } from '../cost/meter.js';
import type { TaskClient } from '../llm/kexiang-task.js';
import type { BrollDeps } from './fulfill.js';
import type { NamedSource } from './gather.js';
import { generateImage, generateVideoFromImage, searchPexels } from './generate-media.js';
import { screenshotUrl } from './screenshot.js';
import { searchUrls } from './search.js';
import { pexelsSource } from './sources/pexels.js';
import { pixabaySource } from './sources/pixabay.js';
import { wikimediaSource } from './sources/wikimedia.js';

/** 联网搜索每次最多取几个网址 */
const SEARCH_TRIES = 2;

/** 免费图库来源：Wikimedia 免 key 一直在；Pexels、Pixabay 只有填了 key 才用 */
export function freeSources(cfg: Pick<AppConfig, 'dataDir'>, keys: { pexelsKey?: string; pixabayKey?: string }): NamedSource[] {
  return [
    ...(keys.pexelsKey ? [{ name: 'pexels' as const, search: pexelsSource(keys.pexelsKey) }] : []),
    ...(keys.pixabayKey ? [{ name: 'pixabay' as const, search: pixabaySource(keys.pixabayKey, { dataDir: cfg.dataDir }) }] : []),
    { name: 'wikimedia', search: wikimediaSource() },
  ];
}

/** 真实依赖：截图、联网搜索（gpt-5.6-luna）、GPT Image 生图、Seedance 图生视频、免费图库 */
export function makeDeps(opts: { apiKey: string; task: TaskClient; cfg: AppConfig; pexelsKey?: string; pixabayKey?: string; meter?: CostMeter }): BrollDeps {
  const { apiKey, task, cfg, pexelsKey, meter } = opts;
  return {
    screenshot: (url, out, size) => screenshotUrl(url, out, size ?? {}),
    search: (query) => searchUrls(apiKey, query, { max: SEARCH_TRIES, meter }),
    image: (prompt, out, o) => generateImage(task, prompt, out, undefined, o?.size),
    video: (prompt, imageUrl, out, onStatus) => generateVideoFromImage(task, prompt, imageUrl, out, cfg, undefined, onStatus),
    ...(pexelsKey ? { pexels: (query: string, out: string) => searchPexels(pexelsKey, query, out) } : {}),
    sources: freeSources(cfg, { pexelsKey, pixabayKey: opts.pixabayKey ?? cfg.pixabayKey }),
  };
}
