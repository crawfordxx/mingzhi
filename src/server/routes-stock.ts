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

/** 无法判断时的提示：保留具体原因（限流、HTTP 状态、网络），抹掉 key */
function unsureText(provider: StockProvider, err: unknown, key: string): string {
  const reason = (err instanceof Error ? err.message : String(err)).split(key).join('***').replace(/^暂时无法校验[^：]*：/, '');
  return `暂时无法校验 ${NAME[provider]} key：${reason || '网络或服务异常'}`;
}

async function save(app: AppCtx, c: RouteCtx): Promise<Record<string, unknown>> {
  const body = await readJsonBody(c.req);
  const provider = providerOf(body.provider);
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) throw new HttpError(400, `请填入 ${NAME[provider]} key`);
  // key 要放进请求头或网址，只允许可见 ASCII；全角字符、空白会让请求在发出前就抛错，不能算成「网络异常」
  if (key.length > MAX_KEY_CHARS || !/^[\x21-\x7e]+$/.test(key)) throw new HttpError(400, 'key 格式不对，请检查是否复制完整（只含英文字母、数字和符号）');
  let valid: boolean;
  try {
    valid = await app.deps.validateStockKey(provider, key);
  } catch (err) {
    throw new HttpError(503, unsureText(provider, err, key));
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
