import type { AppCtx } from './context.js';
import { HttpError, readJsonBody, sendJson, sendNoContent } from './http.js';
import { route, type Route, type RouteCtx } from './router.js';
import { isStockProvider, type StockProvider } from './stock-validate.js';

const MAX_KEY_CHARS = 300;
const NAME: Record<StockProvider, string> = { pexels: 'Pexels', pixabay: 'Pixabay' };
const SIGNUP: Record<StockProvider, string> = { pexels: 'pexels.com/api', pixabay: 'pixabay.com/api/docs' };

function providerOf(raw: unknown): StockProvider {
  if (!isStockProvider(raw)) throw new HttpError(400, '图库只支持 pexels 或 pixabay');
  return raw;
}

async function save(app: AppCtx, c: RouteCtx): Promise<Record<string, unknown>> {
  const body = await readJsonBody(c.req);
  const provider = providerOf(body.provider);
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) throw new HttpError(400, `请填入 ${NAME[provider]} key`);
  if (key.length > MAX_KEY_CHARS || /\s/.test(key)) throw new HttpError(400, 'key 格式不对，请检查是否复制完整');
  let valid: boolean;
  try {
    valid = await app.deps.validateStockKey(provider, key);
  } catch {
    throw new HttpError(503, `暂时无法校验 ${NAME[provider]} key（网络或服务异常），请稍后重试`);
  }
  if (!valid) throw new HttpError(400, `${NAME[provider]} key 无效，请检查是否复制完整，或到 ${SIGNUP[provider]} 重新获取`);
  try {
    await app.stock.set(provider, key);
  } catch (err) {
    throw new HttpError(500, `保存 key 失败：${err instanceof Error ? err.message.split(key).join('***') : '未知错误'}`);
  }
  return { ...(await app.stock.infoAll()) };
}

export function stockRoutes(app: AppCtx): Route[] {
  return [
    route('GET', 'api/stock-keys', async (c) => sendJson(c.res, 200, await app.stock.infoAll())),
    route('POST', 'api/stock-keys', async (c) => sendJson(c.res, 200, await save(app, c))),
    route('DELETE', 'api/stock-keys', async (c) => {
      await app.stock.clear(providerOf(c.query.get('provider')));
      sendNoContent(c.res);
    }),
  ];
}
