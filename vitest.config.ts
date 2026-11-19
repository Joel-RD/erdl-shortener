import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3000',
      ADMIN_TOKEN: 'test-admin-token-0123456789',
      IP_HASH_SECRET: 'test-ip-hash-secret-0123456789',
      FORM_TOKEN_SECRET: 'test-form-secret-0123456789',
      IP_RETENTION_DAYS: '45',
      DATABASE_URL: 'file::memory:',
      LOG_LEVEL: 'silent',
      TRUST_PROXY: '0',
    },
  },
});
