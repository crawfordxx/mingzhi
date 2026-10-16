import { configDefaults, defineConfig } from 'vitest/config';

/** 真实渲染类测试：耗 CPU 与内存，单独串行跑（见 vitest.serial.config.ts） */
export const SERIAL_TESTS = [
  'tests/compose.test.ts',
  'tests/templates.test.ts',
  'tests/caption-band.test.ts',
  'tests/cover.test.ts',
  'tests/segments.test.ts',
  'tests/runner-e2e.test.ts',
  'tests/remotion-cache-real.test.ts',
  'tests/broll-process.test.ts',
  'tests/layouts-render.test.ts',
  'tests/outro-render.test.ts',
  'tests/storyboard-render.test.ts',
  'tests/qa-film-render.test.ts',
  'tests/grain-render.test.ts',
  'tests/card-wipe-render.test.ts',
  'tests/cta-hook-render.test.ts',
  'tests/pipeline-qa.test.ts',
];

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], exclude: [...configDefaults.exclude, ...SERIAL_TESTS], testTimeout: 120_000 },
});
