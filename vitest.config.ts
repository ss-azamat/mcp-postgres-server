import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests talk to a real Postgres (PG_TEST_URL); give them headroom.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Transport entry points are I/O glue (HTTP/listeners or ssh2 forwarding). Their logic is tested
      // through real loopback transports and injected boundaries; forcing line coverage over shutdown and
      // fatal-process branches would add mocks rather than confidence. Security/config/core stay at 100%.
      exclude: ['src/http.ts', 'src/ssh-connector.ts'],
      // 100% is the bar for the core, and CI enforces it. Run with PG_TEST_URL set: the
      // integration suite covers the paths that only a real engine exercises.
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
