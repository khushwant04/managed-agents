import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test against the client's sources so `npm test` does not need a build first.
    alias: { '@managed-agents/client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
});
