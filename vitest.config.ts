import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3000',
      ADMIN_TOKEN: 'test-admin-token-0123456789',
      LOG_LEVEL: 'silent',
      TRUST_PROXY: '0',
    },
  },
});
