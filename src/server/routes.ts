import { readFileSync } from 'node:fs';
import { isFakeMode } from './fake.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { musicReady, fontsReady } from '../assets/catalog.js';
import { PRESETS } from '../background/presets.js';
import { CAPTION_STYLES, DEFAULT_CAPTION_STYLE } from '../captions/styles.js';
import { COVER_STYLES, DEFAULT_COVER_STYLE } from '../cover/styles.js';
import { modelsReady } from '../asr/local-asr.js';
import { rvmReady } from '../matting/rvm.js';
import { run } from '../media/exec.js';
import type { AppCtx } from './context.js';
import { HttpError, readJsonBody, sendJson, sendNoContent } from './http.js';
import { activeKey, maskKey } from './keys.js';
import { handleBackgroundThumb, handleCaptionPreview, handleMedia } from './media.js';
import { route, type Route } from './router.js';
import { creditRoutes } from './routes-credits.js';
import { runRoutes } from './routes-runs.js';
import { spaceRoutes } from './routes-spaces.js';
import { stockRoutes } from './routes-stock.js';
import { DEFAULT_SETTINGS } from './spaces.js';

const MAX_KEY_CHARS = 300;
const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

const appVersion = (): string => {
  try {
    return (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
};

/** 只缓存成功：用户装好 ffmpeg 后不必重启服务 */
let ffmpegOk = false;
async function ffmpegReady(app: AppCtx): Promise<boolean> {
  if (!ffmpegOk) ffmpegOk = await run(app.cfg.ffmpeg, ['-version']).then(() => true, () => false);
  return ffmpegOk;
}

async function status(app: AppCtx): Promise<Record<string, unknown>> {
  const { cfg } = app;
  return {
    version: appVersion(),
    keyConfigured: (await activeKey(app)) !== null,
    modelsReady: modelsReady(cfg.modelsDir) && rvmReady(cfg.modelsDir),
    assetsReady: fontsReady(cfg) && musicReady(cfg),
    ffmpegReady: await ffmpegReady(app),
    // 假模型模式（MINGZHI_FAKE_LLM=1，仅测试用）：界面公告条据此显示标识
    ...(isFakeMode() ? { fake: true } : {}),
  };
}

async function keyInfo(app: AppCtx): Promise<Record<string, unknown>> {
  const active = await activeKey(app);
  return active ? { configured: true, source: active.source, masked: maskKey(active.key) } : { configured: false };
}

async function saveKey(app: AppCtx, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) throw new HttpError(400, '请填入 key');
  if (key.length > MAX_KEY_CHARS || /\s/.test(key)) throw new HttpError(400, 'key 格式不对，请检查是否复制完整');
  let valid: boolean;
  try {
    valid = await app.deps.validateKey(key);
  } catch {
    throw new HttpError(503, '暂时无法校验 key（网络或可想 AI 服务异常），请稍后重试');
  }
  if (!valid) throw new HttpError(400, 'key 无效，请检查是否复制完整，或到 kexiangai.com 重新获取');
  try {
    await app.keyStore.set(key);
    app.keys.invalidate();
  } catch (err) {
    throw new HttpError(500, `保存 key 失败：${err instanceof Error ? err.message.split(key).join('***') : '未知错误'}`);
  }
  return keyInfo(app);
}

function options(): Record<string, unknown> {
  return {
    backgrounds: PRESETS.map((p) => ({ id: p.id, name: p.name, thumb: `/thumbs/backgrounds/${p.id}.jpg` })),
    captionStyles: Object.entries(CAPTION_STYLES).map(([id, s]) => ({ id, name: s.name, preview: `/previews/captions/${id}.png` })),
    coverStyles: Object.entries(COVER_STYLES).map(([id, s]) => ({ id, name: s.name, example: `/covers/${id}.webp` })),
    defaults: { ...DEFAULT_SETTINGS, captionStyle: DEFAULT_CAPTION_STYLE, coverStyle: DEFAULT_COVER_STYLE },
  };
}

export function buildRoutes(app: AppCtx): Route[] {
  return [
    route('GET', 'api/status', async (c) => sendJson(c.res, 200, await status(app))),
    route('GET', 'api/options', (c) => sendJson(c.res, 200, options())),
    route('GET', 'api/key', async (c) => sendJson(c.res, 200, await keyInfo(app))),
    route('POST', 'api/key', async (c) => sendJson(c.res, 200, await saveKey(app, await readJsonBody(c.req)))),
    route('DELETE', 'api/key', async (c) => {
      await app.keyStore.clear();
      app.keys.invalidate();
      sendNoContent(c.res);
    }),
    ...stockRoutes(app),
    ...spaceRoutes(app),
    ...runRoutes(app),
    ...creditRoutes(app),
    route('GET', 'media/:id/:n/:file', (c) => handleMedia(app, c)),
    route('GET', 'thumbs/backgrounds/:file', (c) => handleBackgroundThumb(app, c)),
    route('GET', 'previews/captions/:file', (c) => handleCaptionPreview(app, c)),
  ];
}
