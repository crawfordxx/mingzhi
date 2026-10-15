import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** 工作台前端：开发时把 /api 与 /media 代理到本机服务（Task 6，默认 4321 端口） */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4321',
      '/media': 'http://127.0.0.1:4321',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
