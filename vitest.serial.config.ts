import { defineConfig } from 'vitest/config';
import { SERIAL_TESTS } from './vitest.config.js';

/** 渲染类测试：逐个文件串行 */
export default defineConfig({
  test: { include: SERIAL_TESTS, testTimeout: 300_000, fileParallelism: false },
});
