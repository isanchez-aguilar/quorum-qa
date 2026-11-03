import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Each test worker gets its own temporary home directory (see the file).
    setupFiles: ['tests/setup-home.ts'],
    // Integration tests drive real git and processes; under load (for example with Docker
    // Desktop running) they can pass 5 s, so the default timeout made them flaky.
    testTimeout: 30_000,
    // Setup and cleanup hooks build and remove real git repositories; a loaded Windows CI
    // runner has needed more than the 10 s default.
    hookTimeout: 60_000,
  },
});
