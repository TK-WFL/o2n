import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'services/auth-proxy/test/**/*.test.ts'],
    environment: 'node',
  },
});
