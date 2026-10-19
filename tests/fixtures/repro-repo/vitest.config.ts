import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '/tmp/quorum-vite',
  test: { include: ['*.test.js'] },
});
