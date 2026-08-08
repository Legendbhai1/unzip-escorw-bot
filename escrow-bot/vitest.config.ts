import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      BOT_TOKEN: 'test_token',
      DATABASE_URL: 'postgresql://escrow:escrow_pass@localhost:5432/escrow_db',
      REDIS_URL: 'redis://localhost:6379',
    },
  },
});
