import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS's dependency injection reads TypeScript decorator metadata. Vitest's default compiler
// (esbuild) drops that metadata, so tests are compiled with SWC instead, as the NestJS docs recommend.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup-env.ts'],
    // Integration tests share one local database; run test files one at a time.
    fileParallelism: false,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
