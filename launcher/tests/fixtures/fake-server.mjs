// 测试用假服务：模拟 `node --import tsx src/server/index.ts` 的 stdout 与 /api/status。
// 行为由环境变量 FAKE_MODE 决定：ok | crash | crash-later | quit-later | silent | not-ready
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const mode = process.env.FAKE_MODE || 'ok';
writeFileSync('fake-env.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
process.stdin.on('end', () => process.exit(0)).resume();

if (mode === 'crash') {
  console.error('启动失败：listen EADDRINUSE: address already in use 127.0.0.1:4321');
  process.exit(1);
}
if (mode === 'silent') setInterval(() => {}, 1000);
else {
  const server = createServer((req, res) => {
    const ok = mode !== 'not-ready' && req.url === '/api/status';
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(ok ? '{"ok":true}' : '{}');
  });
  // 测试里用系统分配的空闲端口（不用 MINGZHI_PORT 指定的 4321，免得与本机正在跑的服务冲突）
  const listen = (port, left) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && left > 0) listen(port + 1, left - 1);
      else throw err;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log('一些无关的日志');
      console.log(`明知AI剪辑 已启动：http://127.0.0.1:${server.address().port}`);
      if (mode === 'quit-later') {
        // 模拟用户在工作台里点「退出」：正常退出，退出码 0
        setTimeout(() => process.exit(0), 1500);
      }
      if (mode === 'crash-later') {
        setTimeout(() => {
          console.error('Error: boom 渲染进程崩了');
          process.exit(3);
        }, 1500);
      }
    });
  };
  listen(0, 0);
}
