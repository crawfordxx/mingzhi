import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { envProxy, parseScutil, proxyFor, proxyAwareFetch, tunnelFetch } from '../src/server/proxy.js';

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.destroy());
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

const listen = (s: Server): Promise<number> => new Promise((r) => {
  servers.push(s);
  s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port));
});

/** 目标站点：记下收到的请求头，回一段 JSON */
async function target(): Promise<{ port: number; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const port = await listen(createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tag_name: 'v0.2.0' }));
  }));
  return { port, seen };
}

/** 最小的 HTTP CONNECT 代理：记下 CONNECT 的目标与 Proxy-Authorization；hang=true 时不回应 */
async function proxy(hang = false): Promise<{ url: string; connects: string[]; auth: (string | undefined)[] }> {
  const connects: string[] = [];
  const auth: (string | undefined)[] = [];
  const server = createServer();
  server.on('connect', (req, client: Socket, head: Buffer) => {
    sockets.push(client);
    connects.push(req.url ?? '');
    auth.push(req.headers['proxy-authorization']);
    if (hang) return;
    const [host, port] = (req.url ?? '').split(':');
    const upstream = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.push(upstream);
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, connects, auth };
}

describe('envProxy：读环境变量里的代理', () => {
  it('HTTPS_PROXY 优先，其次小写与 HTTP_PROXY', () => {
    expect(envProxy({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' })).toBe('http://a:1');
    expect(envProxy({ https_proxy: 'http://c:3' })).toBe('http://c:3');
    expect(envProxy({ HTTP_PROXY: 'http://b:2' })).toBe('http://b:2');
    expect(envProxy({})).toBeUndefined();
  });

  it('只支持 http:// 代理（socks 等忽略，走直连）', () => {
    expect(envProxy({ HTTPS_PROXY: 'socks5://127.0.0.1:7890' })).toBeUndefined();
    expect(envProxy({ HTTPS_PROXY: '127.0.0.1:7890' })).toBe('http://127.0.0.1:7890');
  });
});

describe('parseScutil：macOS 系统代理', () => {
  const OUT = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7898
  HTTPSProxy : 127.0.0.2
}`;
  it('优先 HTTPS 代理', () => {
    expect(parseScutil(OUT)).toBe('http://127.0.0.2:7898');
  });
  it('HTTPS 关着时用 HTTP 代理；都关着为 undefined', () => {
    expect(parseScutil(OUT.replace('HTTPSEnable : 1', 'HTTPSEnable : 0'))).toBe('http://127.0.0.1:7897');
    expect(parseScutil('<dictionary> {\n  HTTPEnable : 0\n}')).toBeUndefined();
  });
});

describe('proxyFor：给 api.github.com 选代理', () => {
  const host = 'api.github.com';
  it('环境变量优先于系统代理', () => {
    expect(proxyFor(host, { HTTPS_PROXY: 'http://e:1' }, () => 'http://s:2')).toBe('http://e:1');
    expect(proxyFor(host, {}, () => 'http://s:2')).toBe('http://s:2');
    expect(proxyFor(host, {}, () => undefined)).toBeUndefined();
  });
  it('NO_PROXY 命中时直连', () => {
    expect(proxyFor(host, { HTTPS_PROXY: 'http://e:1', NO_PROXY: 'localhost,.github.com' }, () => undefined)).toBeUndefined();
    expect(proxyFor(host, { HTTPS_PROXY: 'http://e:1', no_proxy: '*' }, () => undefined)).toBeUndefined();
    expect(proxyFor(host, { HTTPS_PROXY: 'http://e:1', NO_PROXY: 'example.com' }, () => undefined)).toBe('http://e:1');
  });
});

describe('tunnelFetch：经 HTTP CONNECT 代理发 GET', () => {
  it('经代理拿到 JSON；目标只收到给定的请求头与中性的 User-Agent（与 Node fetch 默认相同）', async () => {
    const t = await target();
    const p = await proxy();
    const res = await tunnelFetch(p.url)(`http://127.0.0.1:${t.port}/repos/x/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tag_name: 'v0.2.0' });
    expect(p.connects).toEqual([`127.0.0.1:${t.port}`]);
    expect(Object.keys(t.seen[0]).sort()).toEqual(['accept', 'connection', 'host', 'user-agent']);
    expect(t.seen[0]['user-agent']).toBe('node');
  });

  it('代理带账号密码时用 Proxy-Authorization（不发给目标）', async () => {
    const t = await target();
    const p = await proxy();
    const withAuth = p.url.replace('http://', 'http://u%40x:p%3Ass@');
    await tunnelFetch(withAuth)(`http://127.0.0.1:${t.port}/`, {});
    expect(p.auth[0]).toBe(`Basic ${Buffer.from('u@x:p:ss').toString('base64')}`);
    expect(t.seen[0]['proxy-authorization']).toBeUndefined();
  });

  it('代理没回应：超时（AbortSignal）后报错', async () => {
    const p = await proxy(true);
    await expect(tunnelFetch(p.url)('http://127.0.0.1:9/', { signal: AbortSignal.timeout(200) })).rejects.toThrow();
  });

  it('代理拒绝（非 200）时报错', async () => {
    const port = await listen(createServer().on('connect', (_req, client: Socket) => { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); }));
    await expect(tunnelFetch(`http://127.0.0.1:${port}`)('http://127.0.0.1:9/', {})).rejects.toThrow(/407/);
  });

  it('代理地址连不上时报错', async () => {
    await expect(tunnelFetch('http://127.0.0.1:9')('http://127.0.0.1:9/', { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  });
});

describe('proxyAwareFetch：检查更新用的 fetch', () => {
  it('有代理时经代理请求', async () => {
    const t = await target();
    const p = await proxy();
    const f = proxyAwareFetch({ HTTPS_PROXY: p.url }, () => undefined);
    const res = await f(`http://127.0.0.1:${t.port}/x`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(p.connects).toHaveLength(1);
  });

  it('没有代理时直连', async () => {
    const t = await target();
    const res = await proxyAwareFetch({}, () => undefined)(`http://127.0.0.1:${t.port}/x`, {});
    expect(res.status).toBe(200);
    expect(t.seen).toHaveLength(1);
  });

  it('NODE_USE_ENV_PROXY=1 时交给 Node 自己的 fetch 处理代理', async () => {
    const t = await target();
    const p = await proxy();
    const res = await proxyAwareFetch({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: p.url }, () => undefined)(`http://127.0.0.1:${t.port}/x`, {});
    expect(res.status).toBe(200);
    expect(p.connects).toHaveLength(0); // 本进程启动时没开 NODE_USE_ENV_PROXY，所以全局 fetch 直连
  });
});
