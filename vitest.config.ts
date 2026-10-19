import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests drive real git and processes; under load (for example with Docker
    // Desktop running) they can pass 5 s, so the default timeout made them flaky.
    testTimeout: 30_000,
  },
});
