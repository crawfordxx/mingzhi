import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 工作台前端：开发时把 /api、/media、/thumbs、/previews 代理到本机服务（Task 6，默认 4321 端口；服务需设 MINGZHI_DEV_PORT=开发端口）。
 * 假数据层（?mock=1）只在开发服务或 VITE_MOCK=1 构建时可用。
 */
export default defineConfig(({ command }) => {
  const mockAllowed = command === 'serve' || process.env.VITE_MOCK === '1';
  // 正式构建：./mock 换成空壳，假数据层与 mock-assets 图片不进模块图（只靠摇树的话图片仍会被输出）
  const noMock = [{ find: /^\.\/mock$/, replacement: fileURLToPath(new URL('./src/mock-off.ts', import.meta.url)) }];
  return {
    plugins: [react()],
    define: { __MOCK_ALLOWED__: JSON.stringify(mockAllowed) },
    resolve: { alias: mockAllowed ? [] : noMock },
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': 'http://127.0.0.1:4321',
        '/media': 'http://127.0.0.1:4321',
        '/thumbs': 'http://127.0.0.1:4321',
        '/previews': 'http://127.0.0.1:4321',
      },
    },
    build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  };
});
